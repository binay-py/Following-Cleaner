// content.js — runs in the context of instagram.com
// Handles all Instagram API calls (same-origin, so no CORS issues) and reports
// progress back to the popup via chrome.runtime.sendMessage.

(() => {
  const IG_APP_ID = "936619743392459";
  const PAGE_SIZE = 200;

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

  function getCsrfToken() {
    return getCookie("csrftoken");
  }

  function getCurrentUserId() {
    return getCookie("ds_user_id");
  }

  let cachedUsername = null;
  async function getCurrentUsername() {
    if (cachedUsername) return cachedUsername;
    const uid = getCurrentUserId();
    if (!uid) return null;
    try {
      const res = await fetch(
        `https://www.instagram.com/api/v1/users/${uid}/info/`,
        { credentials: "include", headers: baseHeaders() }
      );
      if (!res.ok) return null;
      const data = await res.json();
      cachedUsername = (data && data.user && data.user.username) || null;
      return cachedUsername;
    } catch (_) { return null; }
  }

  function postProgress(payload) {
    try {
      chrome.runtime.sendMessage({ type: "progress", payload });
    } catch (_) { /* popup may be closed; ignore */ }
  }

  function baseHeaders() {
    return {
      "X-IG-App-ID": IG_APP_ID,
      "X-Requested-With": "XMLHttpRequest",
      "X-ASBD-ID": "129477",
      "Accept": "*/*",
    };
  }

  // ---------- fetch with rate-limit handling ----------
  async function apiGet(url) {
    let attempt = 0;
    while (true) {
      attempt++;
      const res = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: baseHeaders(),
      });
      if (res.status === 429) {
        postProgress({
          stage: "rate_limited",
          message: "Rate limited — waiting 60s…",
        });
        await sleep(60000);
        if (attempt > 5) throw new Error("Repeated rate limits, giving up.");
        continue;
      }
      if (!res.ok) {
        throw new Error(`Request failed (${res.status}) for ${url}`);
      }
      return res.json();
    }
  }

  async function apiPost(url, body) {
    const csrf = getCsrfToken();
    if (!csrf) throw new Error("Missing CSRF token. Please log in to Instagram.");
    const res = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: {
        ...baseHeaders(),
        "X-CSRFToken": csrf,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body || "",
    });
    if (res.status === 429) {
      const err = new Error("rate_limited");
      err.code = 429;
      throw err;
    }
    if (!res.ok) throw new Error(`POST failed (${res.status}) for ${url}`);
    return res.json();
  }

  // ---------- core API actions ----------
  async function fetchAllFollowing(userId) {
    const out = [];
    let nextMaxId = null;
    let page = 0;
    while (true) {
      page++;
      const url =
        `https://www.instagram.com/api/v1/friendships/${userId}/following/` +
        `?count=${PAGE_SIZE}` +
        (nextMaxId ? `&max_id=${encodeURIComponent(nextMaxId)}` : "");
      const data = await apiGet(url);
      const users = data.users || [];
      for (const u of users) {
        out.push({
          user_id: String(u.pk || u.pk_id || u.id),
          username: u.username,
          full_name: u.full_name || "",
          profile_pic_url: u.profile_pic_url || "",
          is_verified: !!u.is_verified,
        });
      }
      postProgress({
        stage: "fetching_following",
        loaded: out.length,
        page,
      });
      nextMaxId = data.next_max_id;
      if (!nextMaxId) break;
      await randomDelay(800, 1600);
    }
    return out;
  }

  async function fetchAllFollowers(userId) {
    const ids = new Set();
    let nextMaxId = null;
    let page = 0;
    while (true) {
      page++;
      const url =
        `https://www.instagram.com/api/v1/friendships/${userId}/followers/` +
        `?count=${PAGE_SIZE}` +
        (nextMaxId ? `&max_id=${encodeURIComponent(nextMaxId)}` : "");
      const data = await apiGet(url);
      const users = data.users || [];
      for (const u of users) ids.add(String(u.pk || u.pk_id || u.id));
      postProgress({
        stage: "fetching_followers",
        loaded: ids.size,
        page,
      });
      nextMaxId = data.next_max_id;
      if (!nextMaxId) break;
      await randomDelay(800, 1600);
    }
    return ids;
  }

  async function unfollowUser(userId) {
    const url = `https://www.instagram.com/api/v1/friendships/destroy/${userId}/`;
    return apiPost(url, "");
  }

  // ---------- orchestration ----------
  let stopRequested = false;

  async function runScan() {
    const userId = getCurrentUserId();
    if (!userId) throw new Error("Not logged in to Instagram.");

    postProgress({ stage: "start_following" });
    const following = await fetchAllFollowing(userId);

    postProgress({ stage: "start_followers" });
    const followerIds = await fetchAllFollowers(userId);

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
    const results = { ok: [], failed: [], stopped: false };

    for (let i = 0; i < targets.length; i++) {
      if (stopRequested) {
        results.stopped = true;
        break;
      }
      const t = targets[i];
      postProgress({
        stage: "unfollowing",
        index: i,
        total: targets.length,
        username: t.username,
      });
      try {
        await unfollowUser(t.user_id);
        results.ok.push(t.user_id);
      } catch (e) {
        if (e && e.code === 429) {
          postProgress({
            stage: "rate_limited",
            message: "Rate limited — pausing 60s…",
          });
          await sleep(60000);
          // retry once
          try {
            await unfollowUser(t.user_id);
            results.ok.push(t.user_id);
          } catch (e2) {
            results.failed.push({ user_id: t.user_id, error: String(e2.message || e2) });
          }
        } else {
          results.failed.push({ user_id: t.user_id, error: String(e.message || e) });
        }
      }
      if (i < targets.length - 1 && !stopRequested) {
        await randomDelay(3000, 8000);
      }
    }
    return results;
  }

  // ---------- message router ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        switch (msg && msg.type) {
          case "ping": {
            const uid = getCurrentUserId();
            const username = uid ? await getCurrentUsername() : null;
            sendResponse({
              ok: true,
              loggedIn: !!uid,
              userId: uid,
              username,
              url: location.href,
            });
            break;
          }
          case "scan": {
            const data = await runScan();
            sendResponse({ ok: true, data });
            break;
          }
          case "unfollow": {
            const data = await runUnfollow(msg.targets || []);
            sendResponse({ ok: true, data });
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
    return true; // async response
  });
})();
