// The hub: one toolbar button, three panels. Everything below the tab strip is
// owned by that area's own panel.js — this file only decides which one is on
// screen. It runs before the panel scripts, but nothing depends on the order.
(() => {
  "use strict";

  const api = globalThis.browser ?? globalThis.chrome;

  // In display order. `host` decides which panel a page opens on; Folders has
  // none because it is the catch-all — tab groups exist on every page.
  const PANELS = [
    { id: "reddit", host: /(^|\.)reddit\.com$/ },
    { id: "youtube", host: /(^|\.)youtube\.com$/ },
    { id: "zen", host: null },
  ];

  const tabs = PANELS.map((p) => document.getElementById(`tab-${p.id}`));

  function select(index) {
    PANELS.forEach((p, i) => {
      const on = i === index;
      tabs[i].setAttribute("aria-selected", String(on));
      tabs[i].tabIndex = on ? 0 : -1;
      document.getElementById(`panel-${p.id}`).hidden = !on;
    });
  }

  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => select(i));
    // Arrow keys move between tabs, which is what a tablist is expected to do.
    tab.addEventListener("keydown", (e) => {
      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const next = (i + step + tabs.length) % tabs.length;
      select(next);
      tabs[next].focus();
    });
  });

  // Open on the panel that matches the page being looked at. The query can fail
  // outright in the options-page embed, where there is no host to match anyway.
  async function openingPanel() {
    let host = "";
    try {
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      host = new URL(tab?.url ?? "").hostname;
    } catch (e) {
      return PANELS.length - 1;
    }
    const i = PANELS.findIndex((p) => p.host?.test(host));
    return i === -1 ? PANELS.length - 1 : i;
  }

  openingPanel().then(select);
})();
