// Reads the globals published by reddit/settings.js, which loads first.
(() => {
  "use strict";

  let settings = { ...DEFAULTS };

  function applyGate() {
    const off = offTokens(settings);
    if (off.length) document.documentElement.setAttribute("data-rt-off", off.join(" "));
    else document.documentElement.removeAttribute("data-rt-off");
  }

  loadSettings().then((s) => {
    settings = s;
    applyGate();
  });

  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key in settings) settings[key] = newValue;
    }
    applyGate();
  });

  // One capture-phase listener is the entire interaction layer. It reads
  // `location` and the live settings on each click, so shreddit's client-side
  // routing needs no MutationObserver, polling, or history hooks.
  document.addEventListener(
    "click",
    (e) => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      if (!settings.enabled) return;

      const a = e.target.closest?.("a[href]");
      if (!a) return;

      // Send the header logo back to the subreddit being read rather than the
      // global front page. Resolved at click time, so it stays correct as
      // shreddit navigates without a reload. Falls through to the home block
      // below when it cannot be rewritten, which is exactly where it would
      // otherwise have gone.
      if (a.id === "reddit-logo" && settings.logoToSubreddit) {
        const sub = location.pathname.match(/^\/r\/[^/]+/);
        if (sub) {
          a.href = sub[0] + "/";
          return;
        }
      }

      // Covers what webRequest cannot: shreddit routes these client-side, so no
      // request is ever made for background.js to redirect.
      // ponytail: clicks and full loads only, add a popstate hook if shreddit
      // turns out to reach the front page some other way
      if (settings.blockHome && isBlockedHome(a.href)) {
        e.preventDefault();
        e.stopPropagation();
        location.href = ext.runtime.getURL("reddit/blocked.html");
        return;
      }

      if (!a.pathname.includes("/comments/")) return;

      const url = commentSortUrl(a.href, settings.sort) || a.href;

      if (settings.commentsNewTab) {
        // shreddit routes post clicks itself and ignores `target`, so the only
        // way to a real new tab is around the router. The new tab full-loads,
        // which is what lets background.js stamp the sort.
        e.preventDefault();
        e.stopPropagation();
        window.open(url, "_blank", "noopener");
      } else {
        a.href = url;
      }
    },
    true
  );
})();
