// Regression tests for content.js.
//
// content.js is a content script: it expects window, document, chrome and a
// same-origin fetch. This harness supplies fakes for all four and runs the file
// in a vm context, then drives it through the message router the same way
// popup.js does. No dependencies — run it with:
//
//   node tests/content.test.mjs
//
// Timers are collapsed to zero so the deliberate human-like delays in
// content.js don't make the suite take minutes.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, "..", "content.js"), "utf8");

const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const user = (pk, username) => ({
  pk,
  username,
  full_name: "",
  profile_pic_url: "",
  is_verified: false,
});

function todayKey() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `unfollow_count_${d.getFullYear()}-${mm}-${dd}`;
}

// Boots a fresh copy of content.js against a fake Instagram.
function boot({ pages, onUnfollow }) {
  const store = {};
  const posted = [];
  let listener = null;

  const realSetTimeout = setTimeout;
  const ctx = {
    console,
    setTimeout: (fn) => realSetTimeout(fn, 0), // collapse every delay
    clearTimeout,
    Math, Date, JSON, Set, Map, Promise, Error,
    String, Number, Array, Object, RegExp, URLSearchParams,
    window: {},
    sessionStorage: { getItem: () => null },
    document: {
      cookie: "ds_user_id=42; csrftoken=tok",
      documentElement: { innerHTML: "" },
    },
    location: { href: "https://www.instagram.com/" },
    chrome: {
      storage: {
        local: {
          async get(key) {
            return typeof key === "string" ? { [key]: store[key] } : { ...store };
          },
          async set(obj) { Object.assign(store, obj); },
        },
      },
      runtime: { onMessage: { addListener: (fn) => { listener = fn; } } },
    },
    async fetch(url, opts = {}) {
      if ((opts.method || "GET") === "POST") {
        posted.push(url);
        return onUnfollow(url, posted.length);
      }
      if (url.includes("/users/42/info/")) {
        return json({ user: { username: "me", follower_count: 3, following_count: 4 } });
      }
      const kind = url.match(/friendships\/42\/(following|followers)\//)[1];
      const cursor = (url.match(/max_id=([^&]*)/) || [])[1] || null;
      return json(pages[kind](cursor));
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);

  return {
    store,
    posted,
    send: (msg) => new Promise((resolve) => listener(msg, {}, resolve)),
    // Bounded wait: a job that never settles is itself the bug we're testing for.
    async settle(maxTicks = 20000) {
      for (let i = 0; i < maxTicks; i++) {
        if (store.job && store.job.status !== "running") return store.job;
        await new Promise((r) => realSetTimeout(r, 1));
      }
      throw new Error(`job never finished: ${JSON.stringify(store.job)}`);
    },
  };
}

const emptyList = () => ({ users: [], next_max_id: null });
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("a repeated pagination cursor ends the walk instead of looping forever", async () => {
  const env = boot({
    pages: {
      following: (cursor) =>
        cursor
          // Instagram hands back the cursor it just served, with users that
          // overlap the previous page.
          ? { users: [user(2, "b"), user(3, "c")], next_max_id: "p2" }
          : { users: [user(1, "a"), user(2, "b")], next_max_id: "p2" },
      followers: () => ({ users: [user(1, "a")], next_max_id: null }),
    },
    onUnfollow: () => json({ status: "ok" }),
  });

  await env.send({ type: "scan" });
  const job = await env.settle();

  assert.strictEqual(job.status, "done", job.error);
  // "b" appeared on both pages but is counted once.
  assert.strictEqual(job.result.following_count, 3);
  assert.strictEqual(
    job.result.non_followers.map((u) => u.username).join(","),
    "b,c"
  );
});

test("each successful unfollow is counted against the daily quota as it happens", async () => {
  const env = boot({
    pages: { following: emptyList, followers: emptyList },
    onUnfollow: () => json({ status: "ok" }),
  });

  const targets = [1, 2, 3].map((n) => ({ user_id: String(n), username: `u${n}` }));
  await env.send({ type: "unfollow", targets });
  const job = await env.settle();

  assert.strictEqual(job.status, "done", job.error);
  assert.strictEqual(job.result.ok.length, 3);
  assert.strictEqual(env.store[todayKey()], 3);
});

test("a run stops once Instagram refuses several unfollows in a row", async () => {
  const env = boot({
    pages: { following: emptyList, followers: emptyList },
    onUnfollow: () => json({ status: "fail", message: "Action blocked" }),
  });

  const targets = Array.from({ length: 20 }, (_, i) => ({
    user_id: String(i),
    username: `u${i}`,
  }));
  await env.send({ type: "unfollow", targets });
  const job = await env.settle();

  assert.strictEqual(job.status, "done", job.error);
  assert.strictEqual(env.posted.length, 5, "should give up long before all 20");
  assert.strictEqual(job.result.failed.length, 5);
  assert.ok(job.result.aborted, "the run should report why it stopped");
});

let failures = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}\n     ${e.message}`);
  }
}
console.log(`\n${tests.length - failures}/${tests.length} passed`);
process.exit(failures ? 1 : 0);
