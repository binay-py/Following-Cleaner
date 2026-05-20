// popup.js — UI controller for the extension popup.

const FREE_DAILY_LIMIT = 10;
const BULK_WARN_THRESHOLD = 100;

const state = {
  igTabId: null,
  results: null,            // { following_count, followers_count, non_followers, scanned_at }
  selected: new Set(),      // user_ids
  whitelist: new Set(),     // user_ids the user never wants suggested for unfollow
  hideProtected: false,     // hide whitelisted rows from the results list
  filter: "",
  unfollowing: false,
  pendingProfileUrl: null,  // if set, primary action navigates current tab here
};

// ---------- whitelist persistence ----------
async function loadWhitelist() {
  const { whitelist } = await chrome.storage.local.get("whitelist");
  state.whitelist = new Set(Array.isArray(whitelist) ? whitelist : []);
}

async function saveWhitelist() {
  await chrome.storage.local.set({ whitelist: [...state.whitelist] });
}

async function toggleWhitelist(uid) {
  if (state.whitelist.has(uid)) {
    state.whitelist.delete(uid);
  } else {
    state.whitelist.add(uid);
    state.selected.delete(uid); // a protected account can't be queued for unfollow
  }
  await saveWhitelist();
  renderResults();
}

// ---------- screen helpers ----------
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

function $(sel) { return document.querySelector(sel); }

// ---------- Active-tab management ----------
// The extension is locked to the currently active tab: it only works when that
// tab is the logged-in user's own profile on instagram.com.

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

function isInstagramUrl(url) {
  return typeof url === "string" && url.startsWith("https://www.instagram.com/");
}

function isOwnProfileUrl(url, username) {
  if (!isInstagramUrl(url) || !username) return false;
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "").toLowerCase();
    return path === "/" + username.toLowerCase();
  } catch (_) { return false; }
}

// Opens the URL in a NEW tab immediately to the right of the current one,
// leaving the user's existing tab untouched.
async function openInNextTab(url) {
  const tab = await getActiveTab();
  const opts = { url, active: true };
  if (tab && typeof tab.index === "number") opts.index = tab.index + 1;
  await chrome.tabs.create(opts);
}

async function navigateActiveTabTo(url) {
  await openInNextTab(url);
}

async function openInstagram() {
  await openInNextTab("https://www.instagram.com/");
}

// Used by scan/unfollow flows — talks to the content script in the active tab,
// which must already be the user's own Instagram profile (gated by the home
// screen). Will inject the content script on demand if it isn't attached.
async function sendToContent(message) {
  const tab = await getActiveTab();
  if (!tab || !isInstagramUrl(tab.url)) {
    throw new Error("This only works on Instagram. Open instagram.com and try again.");
  }
  state.igTabId = tab.id;
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (e) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
      await new Promise((r) => setTimeout(r, 300));
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch (e2) {
      throw new Error("Cannot reach the Instagram tab. Reload instagram.com and try again.");
    }
  }
}

// ---------- home-screen state machine ----------
// Four states:
//   1. Not on instagram.com         → "Open Instagram"
//   2. On IG but not logged in      → "Log in to Instagram"
//   3. On IG but wrong page         → "Go to @{username}"
//   4. On own profile + logged in   → Scan enabled
async function refreshHomeState() {
  const dot = $("#login-status");
  const text = $("#login-text");
  const openBtn = $("#btn-open-ig");
  const scanBtn = $("#btn-scan");

  const setReady = (username) => {
    dot.className = "status-dot ok";
    text.textContent = `Ready — @${username}'s profile`;
    scanBtn.classList.remove("hidden");
    scanBtn.disabled = false;
    openBtn.classList.add("hidden");
    state.pendingProfileUrl = null;
  };
  const setPrimaryAction = (statusMsg, btnLabel, profileUrl = null) => {
    dot.className = "status-dot bad";
    text.textContent = statusMsg;
    scanBtn.classList.add("hidden");
    openBtn.classList.remove("hidden", "ghost");
    openBtn.classList.add("primary");
    openBtn.textContent = btnLabel;
    state.pendingProfileUrl = profileUrl;
  };

  dot.className = "status-dot pending";
  text.textContent = "Checking current tab…";
  openBtn.classList.add("hidden");
  scanBtn.classList.remove("hidden");

  const tab = await getActiveTab();

  // State 1: not on Instagram
  if (!tab || !isInstagramUrl(tab.url)) {
    setPrimaryAction("Open Instagram to use this extension.", "Open Instagram");
    return;
  }

  state.igTabId = tab.id;

  // Ping content script (inject if needed) and get session + username
  let info;
  try {
    info = await chrome.tabs.sendMessage(tab.id, { type: "ping" });
  } catch (_) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id }, files: ["content.js"],
      });
      await new Promise((r) => setTimeout(r, 350));
      info = await chrome.tabs.sendMessage(tab.id, { type: "ping" });
    } catch (_) {
      setPrimaryAction("Reload Instagram and try again.", "Reload Instagram");
      return;
    }
  }

  // State 2: not logged in
  if (!info || !info.ok || !info.loggedIn) {
    setPrimaryAction("You're not logged in to Instagram.", "Log in to Instagram");
    return;
  }

  const username = info.username;
  if (!username) {
    setPrimaryAction("Couldn't verify your account. Reload Instagram.", "Reload Instagram");
    return;
  }

  // State 3: on IG but not the user's own profile page
  if (!isOwnProfileUrl(tab.url, username)) {
    const profileUrl = `https://www.instagram.com/${username}/`;
    setPrimaryAction(
      `Open your profile to scan it.`,
      `Go to @${username}`,
      profileUrl
    );
    return;
  }

  // State 4: ready
  setReady(username);
}

// ---------- scan flow ----------
async function startScan() {
  // Pre-flight: re-verify the active tab still matches the gate. If anything
  // drifted (user switched tabs, navigated away, signed out), send them back
  // through the home-screen state machine rather than failing mid-scan.
  const tab = await getActiveTab();
  if (!tab || !isInstagramUrl(tab.url)) {
    await refreshHomeState();
    return;
  }
  state.igTabId = tab.id;
  try {
    const ping = await chrome.tabs.sendMessage(tab.id, { type: "ping" });
    if (
      !ping || !ping.ok || !ping.loggedIn ||
      !isOwnProfileUrl(tab.url, ping.username)
    ) {
      await refreshHomeState();
      return;
    }
  } catch (_) {
    // content script not injected — sendToContent will inject it.
  }

  showScreen("screen-loading");
  $("#progress-bar").style.width = "10%";
  $("#loading-text").textContent = "Fetching your following list…";
  $("#loading-detail").textContent = "";

  try {
    const res = await sendToContent({ type: "scan" });
    if (!res || !res.ok) throw new Error(res && res.error || "Scan failed");
    state.results = res.data;
    await chrome.storage.local.set({ last_scan: res.data });
    renderResults();
    showScreen("screen-results");
  } catch (e) {
    showError(e.message || String(e));
  }
}

// ---------- progress listener ----------
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "progress") return;
  const p = msg.payload || {};
  if (p.stage === "fetching_following") {
    $("#progress-bar").style.width = "35%";
    $("#loading-text").textContent = `Fetching following… ${p.loaded}`;
    $("#loading-detail").textContent = `Page ${p.page}`;
  } else if (p.stage === "start_followers") {
    $("#progress-bar").style.width = "55%";
    $("#loading-text").textContent = "Fetching your followers…";
  } else if (p.stage === "fetching_followers") {
    const pct = Math.min(95, 55 + Math.min(40, p.loaded / 50));
    $("#progress-bar").style.width = `${pct}%`;
    $("#loading-text").textContent = `Fetching followers… ${p.loaded}`;
    $("#loading-detail").textContent = `Page ${p.page}`;
  } else if (p.stage === "rate_limited") {
    $("#loading-detail").textContent = p.message || "Rate limited, waiting…";
    $("#unfollow-status").textContent = p.message || "Rate limited, waiting…";
  } else if (p.stage === "unfollowing") {
    const total = p.total || 1;
    const done = p.index || 0;
    const pct = (done / total) * 100;
    $("#unfollow-bar").style.width = `${pct}%`;
    $("#unfollow-count").textContent = `${done + 1} / ${total}`;
    $("#current-username").textContent = "@" + (p.username || "—");
    $("#unfollow-status").textContent = "";
    const remaining = Math.max(0, total - done - 1);
    if (remaining > 0) {
      const seconds = Math.round(remaining * 5.5);
      const min = Math.floor(seconds / 60);
      const sec = seconds % 60;
      $("#unfollow-eta").textContent =
        `~${min > 0 ? `${min}m ` : ""}${sec}s remaining`;
    } else {
      $("#unfollow-eta").textContent = "Finishing up…";
    }
  }
});

// ---------- results rendering ----------
function renderResults() {
  const r = state.results;
  $("#stat-following").textContent = r.following_count;
  $("#stat-followers").textContent = r.followers_count;
  $("#stat-nonfollowers").textContent = r.non_followers.length;

  const list = $("#user-list");
  list.innerHTML = "";

  const filtered = filteredUsers();
  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = state.filter
      ? "No users match your search."
      : state.hideProtected && protectedInResults() > 0
        ? "All remaining non-followers are protected."
        : "Great — everyone you follow follows you back!";
    list.appendChild(empty);
    updateSelectedCount();
    return;
  }

  const frag = document.createDocumentFragment();
  for (const u of filtered) {
    const isProtected = state.whitelist.has(u.user_id);

    const row = document.createElement("div");
    row.className = "user-row";
    if (isProtected) row.classList.add("whitelisted");
    if (!isProtected && state.selected.has(u.user_id)) row.classList.add("selected");
    row.dataset.uid = u.user_id;

    const img = document.createElement("img");
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.src = u.profile_pic_url || "";
    img.onerror = () => { img.style.visibility = "hidden"; };

    const info = document.createElement("div");
    info.className = "user-info";
    const uname = document.createElement("div");
    uname.className = "uname";
    uname.textContent = "@" + u.username;
    if (u.is_verified) {
      const v = document.createElement("span");
      v.className = "verified";
      v.textContent = "✓";
      v.title = "Verified";
      uname.appendChild(v);
    }
    const fname = document.createElement("div");
    fname.className = "fname";
    fname.textContent = u.full_name || "";
    info.appendChild(uname);
    info.appendChild(fname);

    // star — toggles whitelist (protected) status
    const star = document.createElement("button");
    star.className = "star-btn";
    star.textContent = isProtected ? "★" : "☆";
    star.title = isProtected
      ? "Protected — won't be unfollowed. Click to remove."
      : "Protect this account from bulk unfollow";
    star.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleWhitelist(u.user_id);
    });

    row.appendChild(img);
    row.appendChild(info);
    row.appendChild(star);

    if (isProtected) {
      const tag = document.createElement("span");
      tag.className = "protected-tag";
      tag.textContent = "Protected";
      row.appendChild(tag);
    } else {
      const cb = document.createElement("div");
      cb.className = "checkbox";
      row.appendChild(cb);
      row.addEventListener("click", () => toggleSelected(u.user_id, row));
    }

    frag.appendChild(row);
  }
  list.appendChild(frag);
  updateSelectedCount();
}

function filteredUsers() {
  if (!state.results) return [];
  let list = state.results.non_followers;
  const f = state.filter.trim().toLowerCase();
  if (f) {
    list = list.filter(
      (u) =>
        u.username.toLowerCase().includes(f) ||
        (u.full_name && u.full_name.toLowerCase().includes(f))
    );
  }
  if (state.hideProtected) {
    list = list.filter((u) => !state.whitelist.has(u.user_id));
  }
  return list;
}

function protectedInResults() {
  if (!state.results) return 0;
  let n = 0;
  for (const u of state.results.non_followers) {
    if (state.whitelist.has(u.user_id)) n++;
  }
  return n;
}

function toggleSelected(uid, row) {
  if (state.whitelist.has(uid)) return; // protected accounts aren't selectable
  if (state.selected.has(uid)) {
    state.selected.delete(uid);
    row.classList.remove("selected");
  } else {
    state.selected.add(uid);
    row.classList.add("selected");
  }
  updateSelectedCount();
}

function updateSelectedCount() {
  const n = state.selected.size;
  $("#selected-count").textContent = `${n} selected`;
  const btn = $("#btn-unfollow");
  btn.textContent = `Unfollow Selected (${n})`;
  btn.disabled = n === 0;
  updateProtectedBar();
}

function updateProtectedBar() {
  const bar = $("#protected-bar");
  const n = protectedInResults();
  if (n === 0) {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  $("#protected-count").textContent =
    `${n} protected account${n === 1 ? "" : "s"} kept safe`;
  $("#btn-toggle-protected").textContent = state.hideProtected ? "Show" : "Hide";
}

// ---------- daily limit (free plan) ----------
function todayKey() {
  const d = new Date();
  return `unfollow_count_${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

async function getTodayCount() {
  const key = todayKey();
  const obj = await chrome.storage.local.get(key);
  return obj[key] || 0;
}

async function bumpTodayCount(n) {
  const key = todayKey();
  const obj = await chrome.storage.local.get(key);
  const next = (obj[key] || 0) + n;
  await chrome.storage.local.set({ [key]: next });
  return next;
}

async function checkProStatus() {
  const { is_pro } = await chrome.storage.local.get("is_pro");
  return !!is_pro;
}

// ---------- unfollow flow ----------
async function startUnfollow() {
  if (state.selected.size === 0) return;

  const isPro = await checkProStatus();
  const todayCount = await getTodayCount();
  // Protected accounts are never unfollowed, even if somehow still selected.
  const targets = state.results.non_followers.filter(
    (u) => state.selected.has(u.user_id) && !state.whitelist.has(u.user_id)
  );
  if (targets.length === 0) return;

  if (!isPro) {
    const remaining = Math.max(0, FREE_DAILY_LIMIT - todayCount);
    if (remaining === 0) {
      alert(
        `Free plan limit reached: ${FREE_DAILY_LIMIT} unfollows/day. Upgrade to Pro for unlimited.`
      );
      return;
    }
    if (targets.length > remaining) {
      const ok = confirm(
        `Free plan allows ${remaining} more unfollow(s) today. Only the first ${remaining} will be processed. Continue?`
      );
      if (!ok) return;
      targets.length = remaining;
    }
  }

  if (targets.length > BULK_WARN_THRESHOLD) {
    const ok = confirm(
      `You're about to unfollow ${targets.length} accounts in one go. ` +
      `Instagram may flag heavy activity. Continue?`
    );
    if (!ok) return;
  } else {
    const ok = confirm(`Unfollow ${targets.length} account(s)?`);
    if (!ok) return;
  }

  state.unfollowing = true;
  showScreen("screen-unfollowing");
  $("#unfollow-bar").style.width = "0%";
  $("#unfollow-count").textContent = `0 / ${targets.length}`;
  $("#current-username").textContent = "—";
  $("#unfollow-status").textContent = "";

  try {
    const res = await sendToContent({ type: "unfollow", targets });
    if (!res || !res.ok) throw new Error(res && res.error || "Unfollow failed");
    const okCount = res.data.ok.length;
    const failCount = res.data.failed.length;
    if (!isPro) await bumpTodayCount(okCount);

    // remove unfollowed users from local results so user can rescan or continue
    const okSet = new Set(res.data.ok);
    state.results.non_followers = state.results.non_followers.filter(
      (u) => !okSet.has(u.user_id)
    );
    state.results.following_count = Math.max(
      0,
      state.results.following_count - okCount
    );
    state.selected.clear();
    await chrome.storage.local.set({ last_scan: state.results });

    $("#done-summary").textContent =
      `Unfollowed ${okCount} account(s).` +
      (failCount ? ` Failed: ${failCount}.` : "") +
      (res.data.stopped ? " (Stopped early.)" : "");
    showScreen("screen-done");
  } catch (e) {
    showError(e.message || String(e));
  } finally {
    state.unfollowing = false;
  }
}

async function stopUnfollow() {
  try {
    await sendToContent({ type: "stop" });
  } catch (_) { /* ignore */ }
}

// ---------- error screen ----------
function showError(msg) {
  $("#error-text").textContent = msg;
  showScreen("screen-error");
}

// ---------- cached scan ----------
function relativeTime(ts) {
  const diff = Math.max(0, Date.now() - ts);
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

async function loadLastScanIndicator() {
  const { last_scan } = await chrome.storage.local.get("last_scan");
  if (last_scan && last_scan.scanned_at) {
    $("#last-scan-time").textContent = relativeTime(last_scan.scanned_at);
    $("#last-scan").classList.remove("hidden");
    state.results = last_scan;
  }
}

async function refreshQuotaLine() {
  const isPro = await checkProStatus();
  const line = $("#quota-line");
  if (!line) return;
  if (isPro) {
    line.textContent = "Unlimited unfollows";
    return;
  }
  const used = await getTodayCount();
  const left = Math.max(0, FREE_DAILY_LIMIT - used);
  line.textContent = `${left} of ${FREE_DAILY_LIMIT} unfollows left today`;
}

// ---------- wire up ----------
document.addEventListener("DOMContentLoaded", () => {
  showScreen("screen-home");
  loadWhitelist();
  loadLastScanIndicator();
  refreshQuotaLine();
  refreshHomeState();

  $("#btn-scan").addEventListener("click", startScan);
  $("#btn-rescan").addEventListener("click", startScan);
  $("#btn-again").addEventListener("click", () => {
    state.selected.clear();
    showScreen("screen-home");
    refreshQuotaLine();
    loadLastScanIndicator();
    refreshHomeState();
  });
  $("#btn-retry").addEventListener("click", () => {
    showScreen("screen-home");
    refreshHomeState();
  });
  $("#btn-error-home").addEventListener("click", () => {
    showScreen("screen-home");
    refreshHomeState();
  });

  $("#btn-load-cached").addEventListener("click", () => {
    if (state.results) {
      renderResults();
      showScreen("screen-results");
    }
  });

  $("#btn-select-all").addEventListener("click", () => {
    for (const u of filteredUsers()) {
      if (!state.whitelist.has(u.user_id)) state.selected.add(u.user_id);
    }
    renderResults();
  });
  $("#btn-toggle-protected").addEventListener("click", () => {
    state.hideProtected = !state.hideProtected;
    renderResults();
  });
  $("#btn-deselect-all").addEventListener("click", () => {
    state.selected.clear();
    renderResults();
  });

  $("#search-input").addEventListener("input", (e) => {
    state.filter = e.target.value;
    renderResults();
  });

  $("#btn-unfollow").addEventListener("click", startUnfollow);
  $("#btn-stop").addEventListener("click", stopUnfollow);

  $("#btn-upgrade").addEventListener("click", () => {
    alert("Pro upgrade is coming soon!");
  });

  // Single button serves two purposes depending on state:
  // - pendingProfileUrl set → navigate active tab to the user's own profile
  // - otherwise            → open Instagram in the active tab
  $("#btn-open-ig").addEventListener("click", async () => {
    if (state.pendingProfileUrl) {
      await navigateActiveTabTo(state.pendingProfileUrl);
    } else {
      await openInstagram();
    }
    window.close();
  });
});
