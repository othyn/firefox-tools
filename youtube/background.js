// IIFE-scoped: this shares the background page with the Reddit and Zen halves,
// and its `DEFAULTS` would otherwise collide with reddit/settings.js.
(() => {
  "use strict";

  // Owns the "saved in Linkding" video-id set and the only context allowed to talk
  // to Linkding: a content-script fetch would run as https://www.youtube.com and be
  // CORS-blocked, whereas this background page (with host permission for the
  // configured Linkding origin) is not. The set is published to content scripts via
  // storage.local (CACHE_KEY) — they repaint on storage.onChanged — so we need no
  // `tabs` permission and no tab broadcasting.
  //
  // This is a Firefox event page (manifest `background.scripts`), so it is unloaded
  // when idle; the cache is the source of truth and is re-read on every wake.

  const api = globalThis.browser ?? globalThis.chrome;
  const storage = api.storage.local;

  const CONFIG_KEY = "ytPlaylistTools.config";
  const CACHE_KEY = "ytPlaylistTools.linkdingCache";

  // Mirror of the Linkding-relevant DEFAULTS (popup.js/content.js hold the full set).
  const DEFAULTS = {
    linkdingEnabled: false,
    linkdingBaseUrl: "https://links.in.othyn.com",
    linkdingApiKey: "",
    linkdingTtlMinutes: 60,
    linkdingMaxPages: 100,
  };

  // Linkding's search (`?q=`) matches title/description/url, so it's only a coarse
  // pre-filter — `youtube` won't match a `youtu.be/…` URL and may pull unrelated
  // hits. We query both terms and let videoIdFromUrl be the real filter, matching
  // every YouTube URL form down to its canonical 11-char id so a `youtu.be/ID`
  // bookmark still matches a `/watch?v=ID` feed thumbnail.
  const SEARCH_TERMS = ["youtube", "youtu.be"];
  const WATCH_RE = /[?&]v=([\w-]{11})/;
  const YOUTU_BE_RE = /youtu\.be\/([\w-]{11})/;
  const SHORTS_RE = /\/shorts\/([\w-]{11})/;
  const EMBED_RE = /\/(?:embed|live)\/([\w-]{11})/;

  /** Pull an 11-char video id out of any YouTube URL form, else null. */
  function videoIdFromUrl(url) {
    if (!url) return null;
    const m =
      url.match(WATCH_RE) ??
      url.match(YOUTU_BE_RE) ??
      url.match(SHORTS_RE) ??
      url.match(EMBED_RE);
    return m ? m[1] : null;
  }

  async function loadConfig() {
    try {
      const { [CONFIG_KEY]: saved } = await storage.get(CONFIG_KEY);
      return { ...DEFAULTS, ...(saved || {}) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  async function readCache() {
    try {
      const { [CACHE_KEY]: c } = await storage.get(CACHE_KEY);
      return c && Array.isArray(c.ids)
        ? c
        : { ids: [], fetchedAt: 0, error: null };
    } catch {
      return { ids: [], fetchedAt: 0, error: null };
    }
  }

  /** Persist the set; the write is itself the broadcast (content scripts watch it). */
  function writeCache(ids, error) {
    return storage
      .set({ [CACHE_KEY]: { ids, fetchedAt: Date.now(), error: error ?? null } })
      .catch(() => {});
  }

  /** Trailing-slash-free origin; null if unparseable / not http(s). */
  function parseBase(baseUrl) {
    try {
      const u = new URL(baseUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      return { base: u.origin, originPattern: `${u.protocol}//${u.host}/*` };
    } catch {
      return null;
    }
  }

  async function hasPermission(originPattern) {
    try {
      return await api.permissions.contains({ origins: [originPattern] });
    } catch {
      return false;
    }
  }

  function ldHeaders(apiKey) {
    // Linkding uses DRF token auth (`Authorization: Token <key>`).
    return { Authorization: `Token ${apiKey}`, Accept: "application/json" };
  }

  /**
   * Crawl the YouTube-matching bookmarks via Linkding's paginated search and keep
   * the ones that yield a video id. Returns { ids, error, total } without touching
   * the cache — callers decide what to persist. `apiKey`/`baseUrl` are passed in so
   * the Test button can probe just-entered (unsaved) credentials. `onePage` fetches
   * only the first page of the first term (a fast connectivity probe).
   */
  async function crawl({ base, apiKey, maxPages, onePage = false }) {
    const ids = new Set();
    const limit = 1000;
    let total = 0;
    let pages = 0;

    for (const term of SEARCH_TERMS) {
      let offset = 0;
      let count = Infinity;
      while (offset < count && pages < maxPages) {
        pages++;
        const url = `${base}/api/bookmarks/?q=${encodeURIComponent(term)}&limit=${limit}&offset=${offset}`;
        let res;
        try {
          res = await fetch(url, { headers: ldHeaders(apiKey) });
        } catch {
          return { ids, error: "network", total, truncated: false };
        }
        if (!res.ok) {
          return { ids, error: `http:${res.status}`, total, truncated: false };
        }

        let body;
        try {
          body = await res.json();
        } catch {
          return { ids, error: "parse", total, truncated: false };
        }

        const results = Array.isArray(body?.results) ? body.results : [];
        for (const b of results) {
          const id = videoIdFromUrl(b?.url);
          if (id) ids.add(id);
        }
        count = body?.count ?? results.length;
        if (term === SEARCH_TERMS[0]) total = count; // headline "YouTube bookmarks" number
        offset += results.length;

        if (results.length === 0 || onePage) break;
      }
      if (onePage) break;
    }

    const truncated = !onePage && pages >= maxPages;
    return { ids, error: truncated ? "truncated" : null, total, truncated };
  }

  let refreshPromise = null;

  /**
   * Refresh the cached set from Linkding. On any failure the previous good ids are
   * preserved (advisory badges shouldn't vanish on a transient blip) — only the
   * error field is updated. Coalesces concurrent calls.
   */
  function fetchSavedIds() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const cfg = await loadConfig();

      if (!cfg.linkdingEnabled || !cfg.linkdingBaseUrl || !cfg.linkdingApiKey) {
        const error = !cfg.linkdingEnabled
          ? null
          : !cfg.linkdingBaseUrl
            ? "bad-url"
            : "no-key";
        await writeCache([], error);
        return { ok: false, count: 0, error };
      }

      const parsed = parseBase(cfg.linkdingBaseUrl);
      if (!parsed) {
        await writeCache([], "bad-url");
        return { ok: false, count: 0, error: "bad-url" };
      }

      if (!(await hasPermission(parsed.originPattern))) {
        const prev = await readCache();
        await writeCache(prev.ids, "no-permission");
        return { ok: false, count: prev.ids.length, error: "no-permission" };
      }

      const { ids, error } = await crawl({
        base: parsed.base,
        apiKey: cfg.linkdingApiKey,
        maxPages: cfg.linkdingMaxPages,
      });

      // A hard failure with no ids means the crawl never started — keep prior set.
      if (error && error !== "truncated" && ids.size === 0) {
        const prev = await readCache();
        await writeCache(prev.ids, error);
        return { ok: false, count: prev.ids.length, error };
      }

      const arr = [...ids];
      await writeCache(arr, error);
      return { ok: true, count: arr.length, error };
    })();

    refreshPromise.finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  /** Probe just-entered credentials (first page only); never overwrites the cache. */
  async function testConnection({ baseUrl, apiKey }) {
    if (!baseUrl || !apiKey) {
      return { ok: false, error: !baseUrl ? "bad-url" : "no-key" };
    }
    const parsed = parseBase(baseUrl);
    if (!parsed) return { ok: false, error: "bad-url" };
    if (!(await hasPermission(parsed.originPattern))) {
      return { ok: false, error: "no-permission" };
    }
    const { ids, error, total } = await crawl({
      base: parsed.base,
      apiKey,
      maxPages: 1,
      onePage: true,
    });
    if (error) return { ok: false, error, total };
    return { ok: true, count: ids.size, total };
  }

  api.runtime.onMessage.addListener((msg) => {
    switch (msg?.type) {
      case "ypt:linkding:getSaved":
        // Non-blocking: hand back whatever's cached, and trigger a refresh in the
        // background if it's stale. The refresh's cache write repaints via
        // storage.onChanged — the page never waits on the network.
        return (async () => {
          const cfg = await loadConfig();
          const cache = await readCache();
          const ttl = cfg.linkdingTtlMinutes * 60_000;
          const fresh =
            !cache.error && cache.fetchedAt && Date.now() - cache.fetchedAt < ttl;
          if (!fresh) fetchSavedIds();
          return { ids: cache.ids, stale: !fresh };
        })();

      case "ypt:linkding:refresh":
        return fetchSavedIds();

      case "ypt:linkding:test":
        return testConnection({ baseUrl: msg.baseUrl, apiKey: msg.apiKey });
    }
  });

  // Any change to the Linkding settings invalidates the set: re-crawl (or, when the
  // feature is switched off / credentials cleared, write an empty cache).
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[CONFIG_KEY]) return;
    const before = changes[CONFIG_KEY].oldValue || {};
    const after = changes[CONFIG_KEY].newValue || {};
    const keys = [
      "linkdingEnabled",
      "linkdingBaseUrl",
      "linkdingApiKey",
      "linkdingTtlMinutes",
      "linkdingMaxPages",
    ];
    if (keys.some((k) => before[k] !== after[k])) fetchSavedIds();
  });

  // Revoking the host permission in about:addons should drop badges immediately.
  if (api.permissions?.onRemoved) {
    api.permissions.onRemoved.addListener(() => {
      loadConfig().then((cfg) => {
        if (!cfg.linkdingBaseUrl) return;
        const parsed = parseBase(cfg.linkdingBaseUrl);
        if (!parsed) return;
        hasPermission(parsed.originPattern).then((ok) => {
          if (!ok) writeCache([], "no-permission");
        });
      });
    });
  }
})();
