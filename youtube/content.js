// Deletion engine originally forked from John-nata/Youtube-Playlist-Cleaner, since
// rewritten to survive YouTube's virtualised playlist; link cleaning is original.

(function () {
  "use strict";

  // WebExtension APIs (Firefox `browser`, Chromium `chrome`).
  const api = globalThis.browser ?? globalThis.chrome;
  const storage = api.storage.local;

  // ---------------------------------------------------------------------------
  // Config & state
  // ---------------------------------------------------------------------------

  // All settings persist now (edited from the toolbar popup, not an in-page
  // panel), so the popup and content script share one stored config object.
  const DEFAULTS = {
    threshold: 0, // % watched required before a video is eligible
    minDelay: 1, // min seconds between deletions
    maxDelay: 2, // max seconds between deletions
    maxDelete: 1000, // safety cap
    pauseAfter: 250, // take a breather every N deletions
    pauseDuration: 60, // seconds to pause for
    autoScrollEvery: 75, // force a load-more scroll every N deletions
    deletePrivate: true, // include "[Private video]" rows
    shuffleDelete: false, // randomise deletion order
    cleanLinks: false, // strip &list/&index from watch links on playlist pages
    forceNewTab: false, // force clean new-tab opens for watch links
    // Linkding "Saved" badges (handled by linkding-badges.js + background.js;
    // kept here only so the three DEFAULTS copies stay in sync).
    linkdingEnabled: false,
    linkdingBaseUrl: "https://links.in.othyn.com",
    linkdingApiKey: "",
    linkdingTtlMinutes: 60,
    linkdingMaxPages: 100,
  };

  const config = { ...DEFAULTS };

  const state = {
    deletedCount: 0,
    currentVideo: 0,
    isPaused: false,
    running: false,
    exporting: false,
    cancelled: false,
    startTime: null,
    consecutiveErrors: 0,
    statusText: "Idle", // mirrored to the popup
    countdownText: "", // mirrored to the popup
  };

  async function loadConfig() {
    try {
      const { "ytPlaylistTools.config": saved } = await storage.get(
        "ytPlaylistTools.config",
      );
      if (saved) Object.assign(config, DEFAULTS, saved);
    } catch {
      /* ignore corrupt / unavailable config */
    }
  }

  // The popup is the settings surface now; mirror its edits into our live config
  // so a mid-session change (delays, link toggles, …) takes effect immediately.
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes["ytPlaylistTools.config"]) return;
    const saved = changes["ytPlaylistTools.config"].newValue;
    if (saved) Object.assign(config, DEFAULTS, saved);
    // Don't re-enable link cleaning mid-run — it's suspended on purpose during a
    // delete (finishRun re-syncs with the latest toggles afterwards).
    if (!state.running) syncLinkCleaning();
  });

  // ---------------------------------------------------------------------------
  // Small shared helpers
  // ---------------------------------------------------------------------------

  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  /** Transient toast, stacked top-right below the navbar. */
  function showToast(message, isError = false) {
    let stack = document.getElementById("ypt-toasts");
    if (!stack) {
      stack = document.createElement("div");
      stack.id = "ypt-toasts";
      Object.assign(stack.style, {
        position: "fixed",
        top: "70px",
        right: "20px",
        zIndex: "100000",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        alignItems: "flex-end",
        pointerEvents: "none",
      });
      document.body.appendChild(stack);
    }

    const el = document.createElement("div");
    el.textContent = message;
    Object.assign(el.style, {
      padding: "8px 14px",
      borderRadius: "6px",
      background: isError ? "#d9534f" : "#5cb85c",
      color: "#fff",
      fontFamily: "Roboto, Arial, sans-serif",
      fontSize: "14px",
      boxShadow: "0 2px 6px rgba(0,0,0,0.3)",
      opacity: "0",
      transition: "opacity 0.3s ease",
    });
    stack.appendChild(el);
    requestAnimationFrame(() => (el.style.opacity = "1"));
    setTimeout(() => {
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 500);
    }, 3000);
  }

  /** Wait for an element to exist (used while menus animate in). */
  function waitForElement(selector, root = document, timeout = 10000) {
    return new Promise((resolve) => {
      const existing = root.querySelector(selector);
      if (existing) return resolve(existing);
      const obs = new MutationObserver(() => {
        const el = root.querySelector(selector);
        if (el) {
          obs.disconnect();
          resolve(el);
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        obs.disconnect();
        resolve(root.querySelector(selector));
      }, timeout);
    });
  }

  /** Retry a (possibly throwing) async op a few times. */
  async function retry(operation, maxAttempts = 3, delay = 1000) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (attempt === maxAttempts) throw error;
        await sleep(delay * attempt);
        showToast(`Retrying (${attempt}/${maxAttempts})…`, true);
      }
    }
  }

  // ===========================================================================
  // Feature: link cleaning
  // ===========================================================================

  let linkObserver = null;
  let linkThrottle = null;

  /** Force a clean open in a new tab, blocking YouTube's SPA navigation. */
  function handleLinkClick(e) {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey)
      return;
    e.preventDefault();
    e.stopImmediatePropagation();
    window.open(e.currentTarget.href, "_blank", "noopener");
  }

  /** Strip playlist params from watch links and wire up new-tab opens. */
  function stripLinkParams() {
    let cleaned = 0;
    let failed = 0;

    document.querySelectorAll('a[href*="watch?v="]').forEach((a) => {
      try {
        const v = new URL(a.href).searchParams.get("v");
        if (!v) return;

        if (config.cleanLinks) {
          const clean = `https://www.youtube.com/watch?v=${v}`;
          if (a.href !== clean) {
            a.href = clean;
            cleaned++;
          }
        }

        a.removeEventListener("click", handleLinkClick, true);
        if (config.forceNewTab)
          a.addEventListener("click", handleLinkClick, true);
      } catch {
        failed++;
      }
    });

    if (cleaned)
      showToast(
        `Cleaned ${cleaned} link${cleaned === 1 ? "" : "s"}${
          failed ? `, ${failed} failed` : ""
        }`,
        failed > 0,
      );
  }

  function throttledClean() {
    if (linkThrottle) return;
    linkThrottle = setTimeout(() => {
      linkThrottle = null;
      stripLinkParams();
    }, 800);
  }

  /** Turn link cleaning on/off to match the current toggles. */
  function syncLinkCleaning() {
    const wanted = config.cleanLinks || config.forceNewTab;

    if (wanted) {
      stripLinkParams();
      if (!linkObserver) {
        const container = document.querySelector("#contents") || document.body;
        linkObserver = new MutationObserver(throttledClean);
        linkObserver.observe(container, { childList: true, subtree: true });
      }
    } else if (linkObserver) {
      linkObserver.disconnect();
      linkObserver = null;
      document
        .querySelectorAll('a[href*="watch?v="]')
        .forEach((a) => a.removeEventListener("click", handleLinkClick, true));
    }
  }

  // ===========================================================================
  // Feature: bulk deletion
  // ===========================================================================

  // "Delete" / "Remove from Watch Later" across YouTube's supported languages.
  const deleteButtonTexts = [
    "Delete",
    "Remove from Watch Later",
    "Eliminar",
    "Quitar de Ver más tarde",
    "Supprimer",
    "Supprimer de À regarder plus tard",
    "Löschen",
    "Aus 'Später ansehen' entfernen",
    "Elimina",
    "Rimuovi da Guarda più tardi",
    "Excluir",
    "Remover de Assistir mais tarde",
    "Удалить",
    "Удалить из списка «Смотреть позже»",
    "削除",
    "後で見るから削除",
    "삭제",
    "나중에 볼 동영상에서 제거",
    "删除",
    "从稍后观看中删除",
    "מחק",
    "מחק מהסט של צפייה בהמשך",
    "إزالة",
    "إزالة من مشاهدة لاحقًا",
    "Verwijderen",
    "Verwijderen van Later bekijken",
    "Usuń",
    "Sil",
    "Törlés",
    "Törlés a Később megnézéshez",
    "Odstranit",
  ].map((t) => t.toLowerCase());

  function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  /** Snapshot the currently-rendered playlist rows. */
  function getVideos() {
    let rows = Array.from(
      document.querySelectorAll("ytd-playlist-video-renderer"),
    );
    if (config.shuffleDelete) rows = shuffleArray(rows);

    const videos = [];
    for (const row of rows) {
      const titleEl = row.querySelector("#video-title");
      const menuEl = row.querySelector("ytd-menu-renderer");
      if (!titleEl || !menuEl) continue;

      // Key off the video id so a row can be tracked across DOM re-queries
      // (the playlist index shifts as videos are deleted).
      const videoId =
        titleEl.href?.match(/[?&]v=([^&]+)/)?.[1] ?? titleEl.innerText;

      // Watched-% lives on a Polymer expando JS property. Firefox content
      // scripts get Xray vision that hides page-set expandos, so reach the
      // real object via wrappedJSObject (undefined elsewhere — falls back).
      const overlay = row.querySelector(
        "ytd-thumbnail-overlay-resume-playback-renderer",
      );

      videos.push({
        videoId,
        title: titleEl.innerText,
        progress:
          (overlay?.wrappedJSObject ?? overlay)?.data?.percentDurationWatched ??
          0,
        menuButton: menuEl.querySelector("yt-icon-button#button"),
        isPrivate:
          row
            .querySelector("yt-formatted-string.ytd-badge-supported-renderer")
            ?.textContent.toLowerCase() === "private",
      });
    }
    return videos;
  }

  /** Open a row's menu and click its delete item. Returns true if clicked. */
  async function deleteVideo(video) {
    let deleted = false;
    try {
      video.menuButton.click();
      const popup = await waitForElement("ytd-menu-popup-renderer");
      await sleep(500); // let menu items render

      const item = Array.from(
        popup.querySelectorAll("ytd-menu-service-item-renderer"),
      ).find((el) => {
        const text = el.textContent.toLowerCase().trim();
        return deleteButtonTexts.some((label) => text.includes(label));
      });

      if (item) {
        item.click();
        deleted = true;
        state.consecutiveErrors = 0;
      } else {
        state.consecutiveErrors++;
        if (state.consecutiveErrors >= 3) {
          const wait = Math.min(30 * state.consecutiveErrors, 300);
          showToast(`Too many errors. Waiting ${wait}s…`, true);
          await countdown(wait);
        }
        throw new Error("Delete button not found");
      }
    } catch (error) {
      console.error(`YT Playlist Tools — ${error.message}`);
    }

    const wait =
      Math.floor(Math.random() * (config.maxDelay - config.minDelay + 1)) +
      config.minDelay;
    await countdown(wait);
    return deleted;
  }

  /** Scroll to the bottom to trigger lazy loading, then back to the top. */
  async function autoScroll() {
    const step = window.innerHeight;
    let height = document.documentElement.scrollHeight;
    for (let y = 0; y <= height; y += step) {
      window.scrollTo(0, y);
      await sleep(120);
      height = document.documentElement.scrollHeight; // grows as rows load
    }
    window.scrollTo(0, 0);
    await sleep(400);
  }

  async function countdown(seconds) {
    for (let i = seconds; i > 0; i--) {
      if (state.cancelled) break;
      state.countdownText = `Next action in ${i}s`;
      reportState();
      await sleep(1000);
    }
    state.countdownText = "";
    reportState();
  }

  function setProgress(deleted) {
    state.deletedCount = deleted;
    state.statusText = `${deleted} / ${config.maxDelete} deleted`;
    reportState();
  }

  /**
   * Walk the whole playlist. YouTube virtualises the list to ~100 rendered
   * rows, so we re-query each pass, delete the first eligible video, and scroll
   * to pull in more — rather than trusting a single snapshot (the old bug that
   * made it stop after ~100). Threshold/private filtering is best-effort on
   * very large lists since the rendered window is limited.
   */
  async function cleanse() {
    state.deletedCount = 0;
    state.currentVideo = 0;
    state.cancelled = false;
    state.consecutiveErrors = 0;
    state.startTime = Date.now();
    setProgress(0);

    await autoScroll();
    await countdown(5);

    const processed = new Set(); // deleted or judged-undeletable, by videoId
    let idleScrolls = 0;

    while (state.deletedCount < config.maxDelete && !state.cancelled) {
      while (state.isPaused && !state.cancelled) await sleep(500);
      if (state.cancelled) break;

      const videos = getVideos();
      const target = videos.find(
        (v) =>
          !processed.has(v.videoId) &&
          v.progress >= config.threshold &&
          (config.deletePrivate || !v.isPrivate),
      );

      // Nothing deletable in view — scroll to surface more rows.
      if (!target) {
        const sigBefore = videos.map((v) => v.videoId).join(",");
        await autoScroll();
        await sleep(800);
        const sigAfter = getVideos()
          .map((v) => v.videoId)
          .join(",");

        // Two scrolls running that change nothing ⇒ end of playlist.
        if (sigAfter === sigBefore) {
          if (++idleScrolls >= 2) break;
        } else {
          idleScrolls = 0;
        }
        continue;
      }

      idleScrolls = 0;
      state.currentVideo++;

      // Mark processed regardless of outcome so an undeletable row can't trap
      // the loop on the same video forever.
      const deleted = await retry(() => deleteVideo(target));
      processed.add(target.videoId);

      if (deleted) {
        state.deletedCount++;
        setProgress(state.deletedCount);

        if (state.deletedCount % config.pauseAfter === 0) {
          showToast(
            `Pausing ${config.pauseDuration}s after ${config.pauseAfter}`,
          );
          await countdown(config.pauseDuration);
        }
        if (state.deletedCount % config.autoScrollEvery === 0) {
          await autoScroll();
        }
      }
    }

    const duration = Math.round((Date.now() - state.startTime) / 1000);
    const note = state.cancelled ? "Stopped" : "Done";
    state.statusText = `${note} — ${state.deletedCount} deleted in ${duration}s`;
    showToast(`${note}: deleted ${state.deletedCount} in ${duration}s`);
    finishRun();
  }

  function startRun() {
    if (state.running) return;
    state.running = true;
    state.isPaused = false;
    state.cancelled = false;
    // Suspend link cleaning — our scrolling/deletions fire constant mutations
    // and re-scanning every anchor each time badly slows the delete loop.
    if (linkObserver) {
      linkObserver.disconnect();
      linkObserver = null;
    }
    reportState();
    cleanse();
  }

  function finishRun() {
    state.running = false;
    state.isPaused = false;
    state.countdownText = "";
    // Restore link cleaning (one pass over whatever loaded + reattach observer).
    syncLinkCleaning();
    reportState();
  }

  // ===========================================================================
  // Feature: export the playlist (read-only)
  // ===========================================================================

  /**
   * Read the currently-rendered rows as {videoId, url, title, author}. Separate
   * from getVideos() on purpose: no shuffle, no watched-% Xray, no menu handles —
   * this is a pure read for the export, and must never perturb the delete engine.
   */
  function scrapeRows() {
    const out = [];
    for (const row of document.querySelectorAll("ytd-playlist-video-renderer")) {
      const titleEl = row.querySelector("#video-title");
      if (!titleEl) continue;
      const hrefId = titleEl.href?.match(/[?&]v=([^&]+)/)?.[1] ?? null;
      // channel-name markup varies; the <a> is the reliable node, with a fallback.
      const authorEl =
        row.querySelector("ytd-channel-name a") ??
        row.querySelector("#channel-name #text");
      out.push({
        videoId: hrefId ?? titleEl.innerText,
        url: hrefId
          ? `https://www.youtube.com/watch?v=${hrefId}`
          : titleEl.href || "",
        title: (titleEl.innerText || "").trim(),
        author: (authorEl?.textContent || "").trim(),
      });
    }
    return out;
  }

  /**
   * Collect every video across the virtualised list, read-only. Unlike the delete
   * engine's autoScroll() (which bounces back to the top each pass because it deletes
   * from the top), export just parks at the bottom and waits there for YouTube to
   * append the next continuation — polling for the rendered row count to grow, so it
   * waits only as long as each load actually takes. Rows are absorbed into a Map keyed
   * by videoId, so anything the list recycles out is still captured once seen.
   */
  async function collectAll() {
    const byId = new Map();
    const rowCount = () =>
      document.querySelectorAll("ytd-playlist-video-renderer").length;
    const absorb = () => {
      for (const v of scrapeRows()) {
        if (v.videoId && !byId.has(v.videoId)) {
          byId.set(v.videoId, {
            url: v.url,
            title: v.title,
            author: v.author,
          });
        }
      }
    };

    // Wait (up to `timeout`) for more rows to render after a scroll, checking often
    // so a fast load moves on immediately instead of sitting out a fixed delay.
    const waitForGrowth = async (prev, timeout = 3000, step = 150) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        await sleep(step);
        if (rowCount() > prev) return true;
      }
      return false;
    };

    absorb();
    let idle = 0;
    // Stop once two waits in a row surface nothing new (end of playlist).
    while (idle < 2) {
      const before = rowCount();
      window.scrollTo(0, document.documentElement.scrollHeight);
      const grew = await waitForGrowth(before);
      absorb();
      idle = grew ? 0 : idle + 1;
    }
    window.scrollTo(0, 0);
    return [...byId.values()];
  }

  /** Timestamped filename, e.g. watch-later-20260727-1430.json. */
  function exportFilename() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
    return `watch-later-${stamp}.json`;
  }

  /** Trigger a download of `data` as pretty JSON (no downloads permission needed). */
  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /**
   * Scroll the whole playlist, collect {url,title,author} for every video, and
   * save it as JSON. Runs to completion in the content script even if the popup
   * closes (like the delete engine) — the download + toast don't depend on it.
   */
  async function exportWatchLater() {
    if (state.running) {
      showToast("Finish the current delete before exporting.", true);
      return { ok: false, error: "busy" };
    }
    if (state.exporting) return { ok: false, error: "busy" };

    state.exporting = true;
    // Suspend link cleaning: the scroll fires constant mutations and re-scanning
    // every anchor each time would badly slow the collect (mirrors startRun).
    if (linkObserver) {
      linkObserver.disconnect();
      linkObserver = null;
    }
    showToast("Exporting — scrolling to load every video…");
    try {
      const videos = await collectAll();
      if (!videos.length) {
        showToast("No videos found to export.", true);
        return { ok: false, error: "empty" };
      }
      downloadJson(exportFilename(), videos);
      showToast(`Exported ${videos.length} video${videos.length === 1 ? "" : "s"}.`);
      return { ok: true, count: videos.length };
    } finally {
      state.exporting = false;
      syncLinkCleaning(); // restore whatever the toggles want
    }
  }

  // ===========================================================================
  // Popup messaging — the toolbar popup is the control surface
  // ===========================================================================

  function stateSnapshot() {
    return {
      onPlaylist: true,
      running: state.running,
      paused: state.isPaused,
      deletedCount: state.deletedCount,
      maxDelete: config.maxDelete,
      statusText: state.statusText,
      countdownText: state.countdownText,
    };
  }

  /** Push current delete progress to an open popup (no-op if none is open). */
  function reportState() {
    api.runtime
      .sendMessage({ type: "ypt:progress", state: stateSnapshot() })
      .catch(() => {});
  }

  // The popup drives the engine: it can query state, start/stop a run, and
  // pause/resume. The engine itself lives here because it must walk and mutate
  // the playlist DOM; the popup is ephemeral and only reflects/controls it.
  api.runtime.onMessage.addListener((msg) => {
    switch (msg?.type) {
      case "ypt:getState":
        return Promise.resolve(stateSnapshot());
      case "ypt:start":
        startRun();
        return Promise.resolve({ ok: true });
      case "ypt:pause":
        if (state.running) state.isPaused = true;
        reportState();
        return Promise.resolve({ ok: true });
      case "ypt:resume":
        if (state.running) state.isPaused = false;
        reportState();
        return Promise.resolve({ ok: true });
      case "ypt:stop":
        state.cancelled = true;
        return Promise.resolve({ ok: true });
      case "ypt:export":
        return exportWatchLater();
    }
  });

  // ===========================================================================
  // Init
  // ===========================================================================

  async function init() {
    // Let other extensions (UnTrap / SponsorBlock, etc.) attach first.
    await sleep(2000);
    await waitForElement("ytd-app");
    await loadConfig();
    syncLinkCleaning();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
