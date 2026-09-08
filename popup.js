// popup.js — UI controller for the extension popup.
//
// The popup no longer runs the job. It asks content.js to start one, then
// renders whatever chrome.storage.local says about it. That means closing the
// popup mid-scan no longer throws the work away.

const FREE_DAILY_LIMIT = 10;
const BULK_WARN_THRESHOLD = 100;

const state = {
  igTabId: null,
  results: null,            // { following_count, followers_count, non_followers, scanned_at }
  selected: new Set(),      // user_ids
  whitelist: new Set(),     // user_ids never offered for unfollow
  hideProtected: false,
  filter: "",
  pendingUrl: null,         // primary button target when we can't scan yet
  unfollowTotal: 0,
};

function $(sel) { return document.querySelector(sel); }

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

function showError(msg) {
  $("#error-text").textContent = msg;
  showScreen("screen-error");
}

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
    state.selected.delete(uid);
  }
  await saveWhitelist();
  renderResults();
}

// ---------- tab plumbing ----------
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

function isInstagramUrl(url) {
  return typeof url === "string" && /^https:\/\/(www\.)?instagram\.com\//.test(url);
}

async function openInNextTab(url) {
  const tab = await getActiveTab();
  const opts = { url, active: true };
  if (tab && typeof tab.index === "number") opts.index = tab.index + 1;
  await chrome.tabs.create(opts);
}

// Sends a message to the content script, injecting it first if it isn't there.
async function sendToContent(message) {
  const tab = await getActiveTab();
  if (!tab || !isInstagramUrl(tab.url)) {
    throw new Error("Open instagram.com in this tab and try again.");
  }
  state.igTabId = tab.id;
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (_) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
    await new Promise((r) => setTimeout(r, 300));
    return await chrome.tabs.sendMessage(tab.id, message);
  }
}

// ---------- home-screen state machine ----------
// 1. not on instagram.com  -> "Open Instagram"
// 2. on IG, not logged in  -> "Log in to Instagram"
// 3. logged in             -> scan enabled
//
// The old build also demanded you be sitting on your own profile page. That
// gate did nothing useful: the API calls are the same from any instagram.com
// page, and it was the most common reason the button refused to appear.
async function refreshHomeState() {
  const dot = $("#login-status");
  const text = $("#login-text");
  const openBtn = $("#btn-open-ig");
  const scanBtn = $("#btn-scan");

  const setReady = (username) => {
    dot.className = "status-dot ok";
    text.textContent = `Ready — signed in as @${username}`;
    scanBtn.classList.remove("hidden");
    scanBtn.disabled = false;
    openBtn.classList.add("hidden");
    state.pendingUrl = null;
  };

  const setAction = (statusMsg, btnLabel, url) => {
    dot.className = "status-dot bad";
    text.textContent = statusMsg;
    scanBtn.classList.add("hidden");
    openBtn.classList.remove("hidden", "ghost");
    openBtn.classList.add("primary");
    openBtn.textContent = btnLabel;
    state.pendingUrl = url || "https://www.instagram.com/";
  };

  dot.className = "status-dot pending";
  text.textContent = "Checking current tab…";
  openBtn.classList.add("hidden");
  scanBtn.classList.remove("hidden");
  scanBtn.disabled = true;

  const tab = await getActiveTab();
  if (!tab || !isInstagramUrl(tab.url)) {
    setAction("Open Instagram to use this extension.", "Open Instagram");
    return;
  }
  state.igTabId = tab.id;

  let info;
  try {
    info = await sendToContent({ type: "ping" });
  } catch (_) {
    setAction("Reload Instagram and try again.", "Reload Instagram", tab.url);
    return;
  }

  if (!info || !info.ok || !info.loggedIn) {
    setAction("You're not logged in to Instagram.", "Log in to Instagram");
    return;
  }
  if (!info.username) {
    setAction("Couldn't verify your account. Reload Instagram.", "Reload Instagram", tab.url);
    return;
  }

  setReady(info.username);
}

// ---------- job rendering ----------
function renderScanProgress(p) {
  const loaded = p.loaded || 0;
  const total = p.total || 0;
  const phaseIsFollowing = p.phase !== "followers";

  // following occupies 0-50% of the bar, followers 50-100%
  let pct;
  if (total > 0) {
    const within = Math.min(1, loaded / total);
    pct = phaseIsFollowing ? within * 50 : 50 + within * 50;
  } else {
    pct = phaseIsFollowing ? 25 : 75;
  }
  $("#progress-bar").style.width = `${Math.max(3, Math.min(99, pct))}%`;

  const label = phaseIsFollowing ? "following" : "followers";
  $("#loading-text").textContent = total
    ? `Fetching ${label}… ${loaded} of ${total}`
    : `Fetching ${label}… ${loaded}`;
  $("#loading-detail").textContent = p.notice || (p.page ? `Page ${p.page}` : "");
}

function renderUnfollowProgress(p) {
  const total = p.total || state.unfollowTotal || 1;
  const done = p.done || 0;
  $("#unfollow-bar").style.width = `${(done / total) * 100}%`;
  $("#unfollow-count").textContent = `${done} / ${total}`;
  $("#current-username").textContent = p.username ? "@" + p.username : "—";
  $("#unfollow-status").textContent = p.notice || "";

  const remaining = Math.max(0, total - done);
  if (remaining > 0) {
    const seconds = Math.round(remaining * 5.5);
    const min = Math.floor(seconds / 60);
    const sec = seconds % 60;
    $("#unfollow-eta").textContent = `~${min > 0 ? `${min}m ` : ""}${sec}s remaining`;
  } else {
    $("#unfollow-eta").textContent = "Finishing up…";
  }
}

async function applyJob(job, { allowJump }) {
  if (!job) return;
  const p = job.progress || {};

  if (job.status === "running") {
    if (job.type === "scan") {
      if (allowJump) showScreen("screen-loading");
      renderScanProgress(p);
    } else {
      if (allowJump) showScreen("screen-unfollowing");
      state.unfollowTotal = p.total || state.unfollowTotal;
      renderUnfollowProgress(p);
    }
    return;
  }

  if (job.status === "error") {
    if (allowJump) showError(job.error || "Something went wrong.");
    return;
  }

  if (job.status === "done" && allowJump) {
    if (job.type === "scan") {
      state.results = job.result;
      state.selected.clear();
      renderResults();
      showScreen("screen-results");
    } else {
      const r = job.result || { ok: [], failed: [], stopped: false };
      const okCount = r.ok.length;
      const failCount = r.failed.length;
      const { last_scan } = await chrome.storage.local.get("last_scan");
      if (last_scan) state.results = last_scan;
      state.selected.clear();
      $("#done-summary").textContent =
        `Unfollowed ${okCount} account(s).` +
        (failCount ? ` Failed: ${failCount}.` : "") +
        (r.stopped ? " (Stopped early.)" : "") +
        (r.aborted ? ` ${r.aborted}` : "");
      showScreen("screen-done");
      refreshQuotaLine();
    }
  }
}

// React to job updates written by the content script.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.job) return;
  startWatchdog();
  applyJob(changes.job.newValue, { allowJump: true });
});

// A running job writes to storage constantly. If it goes quiet for longer than
// this, the content script died (page reloaded, tab closed) and nobody is
// coming back to finish it.
const STALE_AFTER_MS = 90000;
let watchdogTimer = null;

function startWatchdog() {
  clearTimeout(watchdogTimer);
  watchdogTimer = setTimeout(async () => {
    const { job } = await chrome.storage.local.get("job");
    if (!job || job.status !== "running") return;
    if (Date.now() - (job.updated_at || 0) < STALE_AFTER_MS) {
      startWatchdog();
      return;
    }
    await chrome.storage.local.set({
      job: {
        ...job,
        status: "error",
        error: "Lost contact with the Instagram tab. Reload it and try again.",
        updated_at: Date.now(),
      },
    });
  }, STALE_AFTER_MS + 1000);
}

// ---------- scan flow ----------
async function startScan() {
  showScreen("screen-loading");
  $("#progress-bar").style.width = "3%";
  $("#loading-text").textContent = "Starting…";
  $("#loading-detail").textContent = "";

  try {
    const res = await sendToContent({ type: "scan" });
    if (!res || !res.ok) throw new Error((res && res.error) || "Scan failed to start.");
  } catch (e) {
    showError(e.message || String(e));
  }
}

// ---------- results rendering ----------
function renderResults() {
  const r = state.results;
  if (!r || !Array.isArray(r.non_followers)) {
    showError("No scan results yet. Run a scan first.");
    return;
  }

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
  if (!state.results || !Array.isArray(state.results.non_followers)) return [];
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
  if (!state.results || !Array.isArray(state.results.non_followers)) return 0;
  let n = 0;
  for (const u of state.results.non_followers) {
    if (state.whitelist.has(u.user_id)) n++;
  }
  return n;
}

function toggleSelected(uid, row) {
  if (state.whitelist.has(uid)) return;
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

// ---------- daily limit ----------
// Padded to match the key content.js writes, so the two agree on what "today"
// means. The old build built the key without padding and disagreed with itself.
function todayKey() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `unfollow_count_${d.getFullYear()}-${mm}-${dd}`;
}

async function getTodayCount() {
  const key = todayKey();
  const obj = await chrome.storage.local.get(key);
  return obj[key] || 0;
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

  const targets = state.results.non_followers.filter(
    (u) => state.selected.has(u.user_id) && !state.whitelist.has(u.user_id)
  );
  if (targets.length === 0) return;

  if (!isPro) {
    const remaining = Math.max(0, FREE_DAILY_LIMIT - todayCount);
    if (remaining === 0) {
      alert(`Free plan limit reached: ${FREE_DAILY_LIMIT} unfollows/day.`);
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

  const message =
    targets.length > BULK_WARN_THRESHOLD
      ? `You're about to unfollow ${targets.length} accounts in one go. Instagram may flag heavy activity. Continue?`
      : `Unfollow ${targets.length} account(s)?`;
  if (!confirm(message)) return;

  state.unfollowTotal = targets.length;
  showScreen("screen-unfollowing");
  $("#unfollow-bar").style.width = "0%";
  $("#unfollow-count").textContent = `0 / ${targets.length}`;
  $("#current-username").textContent = "—";
  $("#unfollow-status").textContent = "";
  $("#unfollow-eta").textContent = "";

  try {
    const res = await sendToContent({ type: "unfollow", targets });
    if (!res || !res.ok) throw new Error((res && res.error) || "Unfollow failed to start.");
  } catch (e) {
    showError(e.message || String(e));
  }
}

async function stopUnfollow() {
  $("#unfollow-status").textContent = "Stopping after the current account…";
  try {
    await sendToContent({ type: "stop" });
  } catch (_) { /* ignore */ }
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
  } else {
    $("#last-scan").classList.add("hidden");
  }
}

async function refreshQuotaLine() {
  const line = $("#quota-line");
  if (!line) return;
  if (await checkProStatus()) {
    line.textContent = "Unlimited unfollows";
    return;
  }
  const used = await getTodayCount();
  const left = Math.max(0, FREE_DAILY_LIMIT - used);
  line.textContent = `${left} of ${FREE_DAILY_LIMIT} unfollows left today`;
}

async function goHome() {
  state.selected.clear();
  showScreen("screen-home");
  await loadLastScanIndicator();
  await refreshQuotaLine();
  await refreshHomeState();
}

// ---------- boot ----------
document.addEventListener("DOMContentLoaded", async () => {
  showScreen("screen-home");
  await loadWhitelist();
  await loadLastScanIndicator();
  await refreshQuotaLine();

  // If a job was running when the popup was last closed, rejoin it instead of
  // showing a stale home screen.
  const { job } = await chrome.storage.local.get("job");
  if (job && job.status === "running") {
    startWatchdog();
    await applyJob(job, { allowJump: true });
  } else {
    await refreshHomeState();
  }

  $("#btn-scan").addEventListener("click", startScan);
  $("#btn-rescan").addEventListener("click", startScan);
  $("#btn-again").addEventListener("click", goHome);
  $("#btn-error-home").addEventListener("click", goHome);

  // Retry re-runs a failed scan. A failed unfollow run is not replayed
  // automatically — the selection that produced it is gone, and silently
  // re-firing unfollows is not something to do on the user's behalf.
  $("#btn-retry").addEventListener("click", async () => {
    const { job } = await chrome.storage.local.get("job");
    if (job && job.type === "unfollow" && job.status === "error") {
      await goHome();
      return;
    }
    await startScan();
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
  $("#btn-deselect-all").addEventListener("click", () => {
    state.selected.clear();
    renderResults();
  });
  $("#btn-toggle-protected").addEventListener("click", () => {
    state.hideProtected = !state.hideProtected;
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

  $("#btn-open-ig").addEventListener("click", async () => {
    await openInNextTab(state.pendingUrl || "https://www.instagram.com/");
    window.close();
  });
});