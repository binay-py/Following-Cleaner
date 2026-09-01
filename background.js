// background.js — minimal service worker.
//
// The real work lives in content.js (it must run same-origin on instagram.com)
// and the UI lives in popup.js. This worker only cleans up job state, so a job
// interrupted by a browser restart can't leave the popup stuck on a progress
// screen forever. A job killed mid-run by a page reload is caught separately by
// the staleness check in popup.js.

async function clearStaleJob() {
  const { job } = await chrome.storage.local.get("job");
  if (job && job.status === "running") {
    await chrome.storage.local.set({
      job: {
        ...job,
        status: "error",
        error: "The job was interrupted. Run it again.",
        updated_at: Date.now(),
      },
    });
  }
}

chrome.runtime.onInstalled.addListener(clearStaleJob);
chrome.runtime.onStartup.addListener(clearStaleJob);