// content.js — runs in the context of instagram.com
//
// Owns every Instagram API call (same-origin, so cookies ride along and there
// is no CORS problem) and owns the *job state*. Job state lives in
// chrome.storage.local rather than in messages, so a scan or an unfollow run
// survives the popup being closed. The popup is a pure viewer of that state.

(() => {
  // ---- injection guard -------------------------------------------------
  // manifest.json already declares this file as a content script, and popup.js
  // also injects it on demand. Without this guard we would register a second
  // onMessage listener and run two copies of every job.
  if (window.__igCleanerLoaded) return;
  window.__igCleanerLoaded = true;

  const IG_APP_ID = "936619743392459";
  const PAGE_SIZE = 50;          // IG silently caps this well below 200
  const MAX_RATE_LIMIT_RETRIES = 5;

  // ---------- helpers ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const randomDelay = (min, max) =>
    sleep(Math.floor(Math.random() * (max - min + 1) + min));

  function getCookie(name) {
    const m = document.cookie.match(
      new RegExp("(?:^|; )" + name.replace(/([.$?*|{}()\[\]\\\/\+^])/g, "\\$1") + "=([^;]*)")
    );
    return m ? decodeURIComponent(m[1]) : null;
  }

  function getCurrentUserId() {
    return getCookie("ds_user_id");
  }

  // The csrftoken cookie is normally readable, but on a freshly loaded page it
  // is occasionally absent. Fall back to the token Instagram inlines into the
  // document.
  function getCsrfToken() {
    const fromCookie = getCookie("csrftoken");
    if (fromCookie) return fromCookie;
    const m = document.documentElement.innerHTML.match(/"csrf_token":"([^"]+)"/);
    return m ? m[1] : null;
  }

  function baseHeaders() {
    return {
      "X-IG-App-ID": IG_APP_ID,
      "X-IG-WWW-Claim": sessionStorage.getItem("www-claim-v2") || "0",
      "X-Requested-With": "XMLHttpRequest",
      "X-ASBD-ID": "129477",
      "Accept": "*/*",
    };
  }

  // ---------- job state (single source of truth) ----------
  // Shape: { type, status, progress, result, error, started_at, updated_at }
  //   type:   "scan" | "unfollow"
  //   status: "running" | "done" | "error"
  let job = null;

  async function writeJob(patch) {
    job = { ...(job || {}), ...patch, updated_at: Date.now() };
    try {
      await chrome.storage.local.set({ job });
    } catch (_) { /* extension context torn down; nothing to do */ }
    return job;
  }

  function progress(patch) {
    // fire-and-forget; the await would only slow the fetch loop down
    writeJob({ progress: { ...((job && job.progress) || {}), ...patch } });
  }

  // ---------- fetch with rate-limit handling ----------
  async function apiGet(url) {
    let rateLimitHits = 0;
    while (true) {
      const res = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: baseHeaders(),
      });

      if (res.status === 429) {
        rateLimitHits++;
        if (rateLimitHits > MAX_RATE_LIMIT_RETRIES) {
          throw new Error("Instagram kept rate-limiting the request. Try again later.");
        }
        progress({ notice: `Rate limited, waiting 60s (${rateLimitHits}/${MAX_RATE_LIMIT_RETRIES})…` });
        await sleep(60000);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error("Instagram rejected the request. Reload instagram.com and make sure you're logged in.");
      }
      if (!res.ok) {
        throw new Error(`Instagram returned ${res.status}. Reload the page and try again.`);
      }

      progress({ notice: "" });
      return res.json();
    }
  }

  async function apiPost(url, bodyParams) {
    const csrf = getCsrfToken();
    if (!csrf) throw new Error("Missing CSRF token. Reload instagram.com and try again.");

    const res = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: {
        ...baseHeaders(),
        "X-CSRFToken": csrf,
        "X-Instagram-AJAX": "1",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(bodyParams || {}).toString(),
    });

    if (res.status === 429) {
      const err = new Error("rate_limited");
      err.code = 429;
      throw err;
    }
    if (!res.ok) throw new Error(`Request failed (${res.status}).`);

    const data = await res.json().catch(() => ({}));
    // IG answers 200 with a status/message body when it blocks an action
    if (data && data.status === "fail") {
      const err = new Error(data.message || "Instagram blocked this action.");
      if (/wait|try again/i.test(data.message || "")) err.code = 429;
      throw err;
    }
    return data;
  }

  // ---------- account info ----------
  let cachedUser = null;
  async function getAccountInfo() {
    if (cachedUser) return cachedUser;
    const uid = getCurrentUserId();
    if (!uid) return null;

    try {
      const data = await apiGet(`https://www.instagram.com/api/v1/users/${uid}/info/`);
      const u = (data && data.user) || null;
      if (u && u.username) {
        cachedUser = {
          userId: uid,
          username: u.username,
          followerCount: u.follower_count || 0,
          followingCount: u.following_count || 0,
        };
        return cachedUser;
      }
    } catch (_) { /* fall through to the backup endpoint */ }

    // Backup: the account-edit form always carries the username
    try {
      const res = await fetch(
        "https://www.instagram.com/api/v1/accounts/edit/web_form_data/",
        { credentials: "include", headers: baseHeaders() }
      );
      if (res.ok) {
        const d = await res.json();
        const uname = d && d.form_data && d.form_data.username;
        if (uname) {
          cachedUser = { userId: uid, username: uname, followerCount: 0, followingCount: 0 };
          return cachedUser;
        }
      }
    } catch (_) { /* give up */ }

    return null;
  }

  // ---------- pagination ----------
  // next_max_id comes back as a string, sometimes a number, and is absent on
  // the final page. Treating a numeric 0 as "no more pages" would truncate the
  // list, so check for null/undefined/"" explicitly.
  function nextCursor(data) {
    const n = data && data.next_max_id;
    if (n === null || n === undefined || n === "") return null;
    return String(n);
  }

  async function fetchFriendships(userId, kind, onPage) {
    const path = kind === "following" ? "following" : "followers";
    const out = [];
    let cursor = null;
    let page = 0;

    while (true) {
      page++;
      const url =
        `https://www.instagram.com/api/v1/friendships/${userId}/${path}/` +
        `?count=${PAGE_SIZE}` +
        (cursor ? `&max_id=${encodeURIComponent(cursor)}` : "");

      const data = await apiGet(url);
      const users = data.users || [];

      for (const u of users) {
        out.push({
          user_id: String(u.pk ?? u.pk_id ?? u.id),
          username: u.username,
          full_name: u.full_name || "",
          profile_pic_url: u.profile_pic_url || "",
          is_verified: !!u.is_verified,
        });
      }

      onPage(out.length, page);

      cursor = nextCursor(data);
      if (!cursor || users.length === 0) break;
      await randomDelay(800, 1600);
    }
    return out;
  }

  async function unfollowUser(userId) {
    return apiPost(
      `https://www.instagram.com/api/v1/friendships/destroy/${userId}/`,
      { user_id: userId, container_module: "profile" }
    );
  }

  // ---------- daily counter (kept here so it survives a closed popup) ----------
  function todayKey() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `unfollow_count_${d.getFullYear()}-${mm}-${dd}`;
  }

  async function bumpTodayCount(n) {
    if (!n) return;
    const key = todayKey();
    const obj = await chrome.storage.local.get(key);
    await chrome.storage.local.set({ [key]: (obj[key] || 0) + n });
  }

  // ---------- orchestration ----------
  let busy = false;
  let stopRequested = false;

  async function runScan() {
    const info = await getAccountInfo();
    if (!info) throw new Error("Not logged in to Instagram.");

    const userId = info.userId;
    const followingTotal = info.followingCount || 0;
    const followersTotal = info.followerCount || 0;

    await writeJob({
      progress: {
        phase: "following",
        loaded: 0,
        total: followingTotal,
        page: 0,
        notice: "",
      },
    });

    const following = await fetchFriendships(userId, "following", (loaded, page) => {
      progress({ phase: "following", loaded, total: followingTotal, page });
    });

    progress({ phase: "followers", loaded: 0, total: followersTotal, page: 0 });

    const followers = await fetchFriendships(userId, "followers", (loaded, page) => {
      progress({ phase: "followers", loaded, total: followersTotal, page });
    });

    const followerIds = new Set(followers.map((u) => u.user_id));
    const nonFollowers = following.filter((u) => !followerIds.has(u.user_id));

    return {
      following_count: following.length,
      followers_count: followerIds.size,
      non_followers: nonFollowers,
      scanned_at: Date.now(),
    };
  }

  async function runUnfollow(targets) {
    stopRequested = false;
    const okIds = [];
    const failed = [];

    for (let i = 0; i < targets.length; i++) {
      if (stopRequested) break;

      const t = targets[i];
      progress({
        done: i,
        total: targets.length,
        username: t.username,
        notice: "",
      });

      try {
        await unfollowUser(t.user_id);
        okIds.push(t.user_id);
      } catch (e) {
        if (e && e.code === 429) {
          progress({ notice: "Rate limited, pausing 60s…" });
          await sleep(60000);
          try {
            await unfollowUser(t.user_id);
            okIds.push(t.user_id);
          } catch (e2) {
            failed.push({ user_id: t.user_id, error: String(e2.message || e2) });
          }
        } else {
          failed.push({ user_id: t.user_id, error: String((e && e.message) || e) });
        }
      }

      // report the row we just finished before sleeping
      progress({ done: i + 1, total: targets.length });

      if (i < targets.length - 1 && !stopRequested) {
        await randomDelay(3000, 8000);
      }
    }

    await bumpTodayCount(okIds.length);

    // Prune the cached scan so a reopened popup shows the truth
    try {
      const { last_scan } = await chrome.storage.local.get("last_scan");
      if (last_scan && Array.isArray(last_scan.non_followers)) {
        const okSet = new Set(okIds);
        last_scan.non_followers = last_scan.non_followers.filter(
          (u) => !okSet.has(u.user_id)
        );
        last_scan.following_count = Math.max(
          0,
          (last_scan.following_count || 0) - okIds.length
        );
        await chrome.storage.local.set({ last_scan });
      }
    } catch (_) { /* non-fatal */ }

    return { ok: okIds, failed, stopped: stopRequested };
  }

  // Starts a job in the background and returns immediately. All further
  // updates land in chrome.storage.local, so the popup can close and reopen.
  async function startJob(type, fn) {
    if (busy) return { ok: false, error: "A job is already running." };
    busy = true;

    await writeJob({
      type,
      status: "running",
      progress: {},
      result: null,
      error: null,
      started_at: Date.now(),
    });

    (async () => {
      try {
        const result = await fn();
        if (type === "scan") {
          await chrome.storage.local.set({ last_scan: result });
        }
        await writeJob({ status: "done", result });
      } catch (e) {
        await writeJob({ status: "error", error: String((e && e.message) || e) });
      } finally {
        busy = false;
      }
    })();

    return { ok: true, started: true };
  }

  // ---------- message router ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        switch (msg && msg.type) {
          case "ping": {
            const info = await getAccountInfo();
            sendResponse({
              ok: true,
              loggedIn: !!(info && info.userId),
              userId: info ? info.userId : null,
              username: info ? info.username : null,
              busy,
              url: location.href,
            });
            break;
          }
          case "scan": {
            sendResponse(await startJob("scan", runScan));
            break;
          }
          case "unfollow": {
            const targets = msg.targets || [];
            sendResponse(await startJob("unfollow", () => runUnfollow(targets)));
            break;
          }
          case "stop": {
            stopRequested = true;
            sendResponse({ ok: true });
            break;
          }
          default:
            sendResponse({ ok: false, error: "unknown_message" });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true; // keep the channel open for the async reply
  });
})();