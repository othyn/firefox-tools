// The Reddit panel of the shared popup. Reads reddit/settings.js globals.
(() => {
  "use strict";

  const sortEl = document.getElementById("sort");
  const toggleEls = TOGGLES.map(({ key }) => [key, document.getElementById(key)]);

  function populateSortOptions() {
    for (const { value, label } of SORT_OPTIONS) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      sortEl.appendChild(opt);
    }
  }

  // The master switch greys out everything it overrides, so the popup never
  // shows a toggle as on while it is having no effect.
  function applyMaster(enabled) {
    sortEl.disabled = !enabled;
    for (const [key, el] of toggleEls) if (key !== "enabled") el.disabled = !enabled;
  }

  function render(settings) {
    for (const [key, el] of toggleEls) el.checked = settings[key];
    sortEl.value = settings.sort;
    applyMaster(settings.enabled);
  }

  async function init() {
    populateSortOptions();
    render(await loadSettings());

    for (const [key, el] of toggleEls) {
      el.addEventListener("change", () => {
        if (key === "enabled") applyMaster(el.checked);
        saveSettings({ [key]: el.checked });
      });
    }

    sortEl.addEventListener("change", () => saveSettings({ sort: sortEl.value }));

    // Keeps the popup and the options page in step with each other, and with
    // other windows and synced devices.
    ext.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      for (const [key, el] of toggleEls) {
        if (!changes[key]) continue;
        el.checked = changes[key].newValue !== false;
        if (key === "enabled") applyMaster(el.checked);
      }
      if (changes.sort) sortEl.value = changes.sort.newValue;
    });
  }

  init();
})();
