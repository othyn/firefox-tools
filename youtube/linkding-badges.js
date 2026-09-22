// Badges feed/sidebar thumbnails whose video is already saved in Linkding.
// The saved-video set is owned by background.js (the only context that can reach
// Linkding without tripping CORS); it's published via storage.local. This script
// just reads that set and renders/keeps badges in sync — no network, no tabs.

(function () {
  "use strict";

  const api = globalThis.browser ?? globalThis.chrome;
  const storage = api.storage.local;

  const CONFIG_KEY = "ytPlaylistTools.config";
  const CACHE_KEY = "ytPlaylistTools.linkdingCache";

  // Feed/sidebar anchors are always /watch?v= or /shorts/ — two forms suffice
  // here (the broader set lives in background.js for parsing stored bookmarks).
  const WATCH_RE = /[?&]v=([\w-]{11})/;
  const SHORTS_RE = /\/shorts\/([\w-]{11})/;

  // A video card links to the same video from BOTH its thumbnail and its title.
  // The thumbnail link wraps the preview image; the title link doesn't. We key
  // off that rather than YouTube's version-stamped class names (which churn —
  // today's grid uses `ytLockupViewModelContentImage`, the old layout used
  // `a#thumbnail`; both wrap the image), so a markup bump won't break us and we
  // badge the thumbnail only, never the title.
  const IMG_SEL = "img, yt-image, yt-thumbnail-view-model, .ytCoreImageHost";

  let savedIds = new Set();
  let started = false;
  let observer = null;

  /** If `a` is a video *thumbnail* link, return its 11-char id, else null. */
  function thumbId(a) {
    const href = a.getAttribute("href") || "";
    const m = href.match(WATCH_RE) ?? href.match(SHORTS_RE);
    if (!m) return null;
    return a.querySelector(IMG_SEL) ? m[1] : null;
  }

  function injectStyles() {
    if (document.getElementById("ypt-saved-style")) return;
    const style = document.createElement("style");
    style.id = "ypt-saved-style";
    // Linkding's brand purple (Spectre.css primary) so it reads as "Linkding".
    style.textContent = `
      .ypt-saved-badge {
        position: absolute; top: 4px; left: 4px; z-index: 2000;
        display: inline-flex; align-items: center; gap: 4px;
        padding: 2px 6px; border-radius: 6px;
        background: #5755d9; color: #fff;
        font: 600 11px/1.2 Roboto, Arial, sans-serif;
        letter-spacing: .02em; pointer-events: none;
        box-shadow: 0 1px 4px rgba(0,0,0,0.4);
      }
    `;
    (document.head ?? document.documentElement).appendChild(style);
  }

  /**
   * Reconcile every rendered thumbnail with the saved set: add a badge to
   * matches that lack one, remove badges from thumbnails no longer saved.
   * Renderer-agnostic — keys off the shared `a#thumbnail` anchor every video
   * card type uses, so it survives YouTube's many renderer types.
   */
  function paint() {
    const haveSaved = savedIds.size > 0;
    document.querySelectorAll("a[href]").forEach((a) => {
      const badge = a.querySelector(":scope > .ypt-saved-badge");
      const id = haveSaved ? thumbId(a) : null;

      if (id && savedIds.has(id)) {
        if (!badge) {
          if (getComputedStyle(a).position === "static")
            a.style.position = "relative";
          const el = document.createElement("span");
          el.className = "ypt-saved-badge";
          el.textContent = "🔖 Saved in Linkding";
          a.appendChild(el);
        }
      } else if (badge) {
        badge.remove();
      }
    });
  }

  let throttle = null;
  function schedulePaint() {
    if (throttle) return;
    throttle = setTimeout(() => {
      throttle = null;
      paint();
    }, 400);
  }

  function applyCache(cache) {
    savedIds = new Set(Array.isArray(cache?.ids) ? cache.ids : []);
    paint();
  }

  function start() {
    if (started) return;
    started = true;
    injectStyles();

    // New thumbnails stream in via infinite scroll; SPA nav swaps whole feeds.
    observer = new MutationObserver(schedulePaint);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("yt-navigate-finish", schedulePaint);

    // Seed straight from the cache, then wake the background so it can refresh a
    // stale set (its cache write repaints us via storage.onChanged below).
    storage
      .get(CACHE_KEY)
      .then(({ [CACHE_KEY]: cache }) => applyCache(cache))
      .catch(() => {});
    api.runtime.sendMessage({ type: "ypt:linkding:getSaved" }).catch(() => {});
  }

  function stop() {
    if (!started) return;
    started = false;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    window.removeEventListener("yt-navigate-finish", schedulePaint);
    savedIds = new Set();
    document
      .querySelectorAll(".ypt-saved-badge")
      .forEach((el) => el.remove());
    document.getElementById("ypt-saved-style")?.remove();
  }

  // Live updates: the background's cache write is our broadcast channel.
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (started && changes[CACHE_KEY]) applyCache(changes[CACHE_KEY].newValue);
    if (changes[CONFIG_KEY]) {
      const enabled = changes[CONFIG_KEY].newValue?.linkdingEnabled === true;
      if (enabled) start();
      else stop();
    }
  });

  // Honour the opt-in toggle on load.
  storage
    .get(CONFIG_KEY)
    .then(({ [CONFIG_KEY]: cfg }) => {
      if (cfg?.linkdingEnabled === true) {
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", start);
        } else {
          start();
        }
      }
    })
    .catch(() => {});
})();
