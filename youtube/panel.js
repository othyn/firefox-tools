// The YouTube panel of the shared popup.
(() => {
  "use strict";

  // Toolbar popup — the control surface for YT Playlist Tools.
  //
  // Settings (toggles + deletion parameters) live in `storage.local` and are read
  // by the content scripts. The bulk-delete engine runs in content.js on the
  // active playlist tab; this popup starts/stops it and reflects its progress.
  // Because a popup auto-closes on blur, the engine keeps running without us —
  // reopening the popup re-syncs live state from the tab.

  const api = globalThis.browser ?? globalThis.chrome;
  const CONFIG_KEY = "ytPlaylistTools.config";

  // Mirror of content.js DEFAULTS so a fresh install populates sensible values.
  const DEFAULTS = {
    threshold: 0,
    minDelay: 1,
    maxDelay: 2,
    maxDelete: 1000,
    pauseAfter: 250,
    pauseDuration: 60,
    autoScrollEvery: 75,
    deletePrivate: true,
    shuffleDelete: false,
    cleanLinks: false,
    forceNewTab: false,
    linkdingEnabled: false,
    linkdingBaseUrl: "https://links.in.othyn.com",
    linkdingApiKey: "",
    linkdingTtlMinutes: 60,
    linkdingMaxPages: 100,
  };

  // `linkdingEnabled` is deliberately NOT here — it gets a bespoke handler so
  // enabling can request the Linkding host permission inside the user gesture.
  const TOGGLES = [
    "cleanLinks",
    "forceNewTab",
    "deletePrivate",
    "shuffleDelete",
  ];

  // Free-text settings (saved on change, not per-keystroke).
  const TEXTS = ["linkdingBaseUrl", "linkdingApiKey"];

  // key → [min, max] (max null = unbounded)
  const NUMBERS = {
    minDelay: [0, 60],
    maxDelay: [0, 60],
    maxDelete: [1, null],
    threshold: [0, 100],
    pauseAfter: [1, null],
    pauseDuration: [1, 3600],
    autoScrollEvery: [1, null],
  };

  let config = { ...DEFAULTS };
  let activeTabId = null;
  let onPlaylist = false;

  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------------------
  // Settings persistence
  // ---------------------------------------------------------------------------

  async function loadConfig() {
    try {
      const { [CONFIG_KEY]: saved } = await api.storage.local.get(CONFIG_KEY);
      config = { ...DEFAULTS, ...(saved || {}) };
    } catch {
      config = { ...DEFAULTS };
    }
  }

  function saveConfig() {
    return api.storage.local.set({ [CONFIG_KEY]: config }).catch(() => {});
  }

  function populate() {
    for (const key of TOGGLES) $(key).checked = !!config[key];
    for (const key of Object.keys(NUMBERS)) $(key).value = config[key];
    for (const key of TEXTS) $(key).value = config[key] ?? "";
    $("linkdingEnabled").checked = !!config.linkdingEnabled;
  }

  function wireInputs() {
    for (const key of TOGGLES) {
      $(key).addEventListener("change", (e) => {
        config[key] = e.target.checked;
        saveConfig();
      });
    }
    for (const [key, [min, max]] of Object.entries(NUMBERS)) {
      $(key).addEventListener("change", (e) => {
        let n = parseInt(e.target.value, 10);
        if (!Number.isFinite(n)) n = DEFAULTS[key];
        if (min != null) n = Math.max(min, n);
        if (max != null) n = Math.min(max, n);
        config[key] = n;
        e.target.value = n;
        saveConfig();
      });
    }
    for (const key of TEXTS) {
      $(key).addEventListener("change", (e) => {
        let v = e.target.value.trim();
        if (key === "linkdingBaseUrl") v = v.replace(/\/+$/, "");
        config[key] = v;
        e.target.value = v;
        saveConfig();
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Linkding "Saved" badges
  // ---------------------------------------------------------------------------

  /** http(s) origin match pattern for permissions.request, or null if invalid. */
  function originPattern(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      return `${u.protocol}//${u.host}/*`;
    } catch {
      return null;
    }
  }

  // Must be called as the first awaited thing in a click/change handler so the
  // user gesture isn't lost. `permissions.request` resolves true without a prompt
  // when the origin is already granted, so we don't pre-check with contains().
  async function ensurePermission(url) {
    const pattern = originPattern(url);
    if (!pattern) return false;
    try {
      return await api.permissions.request({ origins: [pattern] });
    } catch {
      return false;
    }
  }

  function setLinkdingStatus(text) {
    $("linkdingStatus").textContent = text || "";
  }

  function describeLinkding(res) {
    if (!res) return "No response from the extension";
    if (res.ok) {
      // A test reports matching YouTube bookmarks; a refresh reports the badged set.
      if (res.total != null)
        return `Connected ✓ — ${res.total} YouTube bookmark${res.total === 1 ? "" : "s"}`;
      const n = res.count ?? 0;
      return `${n} saved YouTube video${n === 1 ? "" : "s"} badged`;
    }
    switch (res.error) {
      case "no-permission":
        return "Permission needed to reach Linkding";
      case "bad-url":
        return "Enter a valid http(s) URL";
      case "no-key":
        return "Add an API token";
      case "network":
        return "Couldn't reach Linkding — is it online?";
      case "parse":
        return "Unexpected response from Linkding";
      case "http:401":
      case "http:403":
        return "Unauthorized — check your API token";
      default:
        if (typeof res.error === "string" && res.error.startsWith("http:"))
          return `Linkding error (${res.error.slice(5)})`;
        return "Something went wrong";
    }
  }

  function wireLinkding() {
    // Bespoke handler (not in TOGGLES): enabling needs the host permission, which
    // can only be requested from within this user gesture.
    $("linkdingEnabled").addEventListener("change", async (e) => {
      if (!e.target.checked) {
        config.linkdingEnabled = false;
        saveConfig();
        setLinkdingStatus("");
        return;
      }
      const url = $("linkdingBaseUrl").value.trim().replace(/\/+$/, "");
      if (!originPattern(url)) {
        e.target.checked = false;
        setLinkdingStatus("Enter a valid Linkding URL first");
        return;
      }
      const granted = await ensurePermission(url); // first await — keeps the gesture
      if (!granted) {
        e.target.checked = false;
        config.linkdingEnabled = false;
        saveConfig();
        setLinkdingStatus("Permission needed to reach Linkding");
        return;
      }
      config.linkdingBaseUrl = url;
      $("linkdingBaseUrl").value = url;
      config.linkdingEnabled = true;
      await saveConfig();
      setLinkdingStatus("Enabled — refreshing…");
      const res = await api.runtime
        .sendMessage({ type: "ypt:linkding:refresh" })
        .catch(() => null);
      setLinkdingStatus(describeLinkding(res));
    });

    $("linkdingTestBtn").addEventListener("click", async () => {
      const url = $("linkdingBaseUrl").value.trim().replace(/\/+$/, "");
      const key = $("linkdingApiKey").value.trim();
      if (!originPattern(url)) return setLinkdingStatus("Enter a valid Linkding URL");
      if (!key) return setLinkdingStatus("Add an API token");

      const granted = await ensurePermission(url); // first await — keeps the gesture
      if (!granted) return setLinkdingStatus("Permission needed to reach Linkding");

      config.linkdingBaseUrl = url;
      config.linkdingApiKey = key;
      $("linkdingBaseUrl").value = url;
      setLinkdingStatus("Testing…");

      const res = await api.runtime
        .sendMessage({ type: "ypt:linkding:test", baseUrl: url, apiKey: key })
        .catch(() => null);
      setLinkdingStatus(describeLinkding(res));

      await saveConfig();
      // If the feature is on, re-crawl with the (possibly new) creds so badges update.
      if (config.linkdingEnabled)
        api.runtime.sendMessage({ type: "ypt:linkding:refresh" }).catch(() => {});
    });
  }

  // ---------------------------------------------------------------------------
  // Delete controls (active playlist tab)
  // ---------------------------------------------------------------------------

  function isPlaylistUrl(url) {
    return !!url && /:\/\/([^/]*\.)?youtube\.com\/playlist/.test(url);
  }

  async function sendToTab(msg) {
    if (activeTabId == null) throw new Error("no tab");
    return api.tabs.sendMessage(activeTabId, msg);
  }

  function idleState() {
    return {
      running: false,
      paused: false,
      deletedCount: 0,
      maxDelete: config.maxDelete,
      statusText: "Idle",
      countdownText: "",
    };
  }

  function renderDisabled() {
    $("startBtn").disabled = true;
    $("pauseBtn").disabled = true;
    $("exportBtn").disabled = true;
    $("startBtn").textContent = "Start deleting";
    $("startBtn").classList.remove("danger");
    $("status").textContent = "Open a playlist page to delete";
    $("countdown").textContent = "";
    $("progressFill").style.width = "0%";
  }

  function renderState(st) {
    $("startBtn").disabled = false;
    // Export is read-only; the only time it can't run is mid-delete.
    $("exportBtn").disabled = st.running;
    $("startBtn").textContent = st.running ? "Stop" : "Start deleting";
    $("startBtn").classList.toggle("danger", st.running);
    $("pauseBtn").disabled = !st.running;
    $("pauseBtn").textContent = st.paused ? "Resume" : "Pause";

    const max = st.maxDelete || config.maxDelete || 0;
    const pct = max ? Math.min(100, (st.deletedCount / max) * 100) : 0;
    $("progressFill").style.width = pct + "%";
    $("status").textContent = st.statusText || "Idle";
    $("countdown").textContent = st.countdownText || "";
  }

  async function attachToTab() {
    let tab = null;
    try {
      [tab] = await api.tabs.query({ active: true, currentWindow: true });
    } catch {
      /* no access — treat as not-a-playlist */
    }
    activeTabId = tab?.id ?? null;
    onPlaylist = isPlaylistUrl(tab?.url);
    $("playlistHint").hidden = onPlaylist;

    if (!onPlaylist) {
      renderDisabled();
      return;
    }
    // Reflect any in-flight delete; fall back to idle if the content script
    // isn't loaded yet (e.g. page still initialising).
    const st = await sendToTab({ type: "ypt:getState" }).catch(() => null);
    renderState(st || idleState());
  }

  function wireDeleteControls() {
    $("startBtn").addEventListener("click", async () => {
      if (!onPlaylist) return;
      const running = $("startBtn").classList.contains("danger");
      await sendToTab({ type: running ? "ypt:stop" : "ypt:start" }).catch(
        () => {},
      );
    });

    $("pauseBtn").addEventListener("click", async () => {
      if (!onPlaylist) return;
      const paused = $("pauseBtn").textContent === "Resume";
      await sendToTab({ type: paused ? "ypt:resume" : "ypt:pause" }).catch(
        () => {},
      );
    });

    // Live progress while the popup is open (engine broadcasts on every change).
    api.runtime.onMessage.addListener((msg) => {
      if (msg?.type === "ypt:progress" && onPlaylist) renderState(msg.state);
    });
  }

  function wireExport() {
    $("exportBtn").addEventListener("click", async () => {
      if (!onPlaylist) return;
      const btn = $("exportBtn");
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Exporting…";
      // The collect runs to completion in the content script even if this popup
      // closes on blur; the file still downloads. We only reflect the result if
      // the popup is still open when it finishes.
      $("exportStatus").textContent = "Scrolling to load every video…";
      const res = await sendToTab({ type: "ypt:export" }).catch(() => null);
      btn.textContent = label;
      btn.disabled = false;
      if (res?.ok)
        $("exportStatus").textContent = `Exported ${res.count} video${
          res.count === 1 ? "" : "s"
        } to your downloads.`;
      else if (res?.error === "busy")
        $("exportStatus").textContent = "Finish the current delete first.";
      else if (res?.error === "empty")
        $("exportStatus").textContent = "No videos found on this page.";
      else
        $("exportStatus").textContent =
          "Export failed — is the playlist fully loaded?";
    });
  }

  // ---------------------------------------------------------------------------

  (async function init() {
    await loadConfig();
    populate();
    wireInputs();
    wireLinkding();
    wireDeleteControls();
    wireExport();
    await attachToTab();
  })();
})();
