// See CLAUDE.md: every script is IIFE-wrapped so the shared background page has
// exactly one set of globals — reddit/settings.js supplies them.
(() => {
  "use strict";

  // Cached synchronously because a blocking webRequest handler cannot await
  // storage. Between event-page startup and the first resolve, requests are
  // decided against DEFAULTS.
  let settings = { ...DEFAULTS };

  loadSettings().then((s) => {
    settings = s;
  });

  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.enabled) settings.enabled = changes.enabled.newValue !== false;
    if (changes.blockHome) settings.blockHome = changes.blockHome.newValue !== false;
    if (changes.sort && VALID_SORTS.has(changes.sort.newValue)) {
      settings.sort = changes.sort.newValue;
    }
  });

  // Stamps the default sort on full page loads: typed URLs, bookmarks, and the
  // new tabs content.js opens. Client-side navigation never reaches here, which
  // is what content.js's click handler is for.
  ext.webRequest.onBeforeRequest.addListener(
    (details) => {
      // No loop-breaker needed, unlike the sort stamp below: the target is a
      // moz-extension: URL and so falls outside this listener's `urls` filter.
      if (settings.enabled && settings.blockHome && isBlockedHome(details.url)) {
        return { redirectUrl: ext.runtime.getURL("reddit/blocked.html") };
      }

      const redirectUrl = commentSortUrl(details.url, settings.enabled ? settings.sort : "off");
      return redirectUrl ? { redirectUrl } : {};
    },
    {
      urls: ["*://reddit.com/*", "*://www.reddit.com/*", "*://sh.reddit.com/*"],
      types: ["main_frame"]
    },
    ["blocking"]
  );
})();
