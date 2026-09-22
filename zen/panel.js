// The Folders panel of the shared popup. `FolderTools` is published by
// zen/lib/folder-tools.js, which is loaded before this file.
(() => {
  "use strict";

  const { SORT_MODES, listGroups } = FolderTools;

  const groupsEl = document.getElementById("groups");
  const emptyEl = document.getElementById("empty");
  const statusEl = document.getElementById("zen-status");
  const tpl = document.getElementById("group-tpl");
  const refreshBtn = document.getElementById("refresh");
  const dryRunInput = document.getElementById("dry-run");

  const previewEl = document.getElementById("preview");
  const previewSummary = document.getElementById("preview-summary");
  const previewList = document.getElementById("preview-list");
  const previewApply = document.getElementById("preview-apply");
  const previewDiscard = document.getElementById("preview-discard");

  // Holds the action that produced the current preview, so Apply can re-run it.
  let pendingAction = null;

  refreshBtn.addEventListener("click", () => render());
  previewDiscard.addEventListener("click", clearPreview);
  previewApply.addEventListener("click", applyPending);

  render();

  async function render({ preserveStatus = false } = {}) {
    if (!preserveStatus) setStatus("Loading…");
    groupsEl.replaceChildren();
    clearPreview();
    let groups;
    try {
      groups = await listGroups();
    } catch (e) {
      setStatus(`Failed: ${e.message}`, { error: true });
      return;
    }

    if (!groups.length) {
      emptyEl.hidden = false;
      if (!preserveStatus) setStatus("");
      return;
    }
    emptyEl.hidden = true;

    for (const g of groups) {
      groupsEl.appendChild(renderGroup(g));
    }
    if (!preserveStatus) {
      setStatus(`${groups.length} folder${groups.length === 1 ? "" : "s"} found.`);
    }
  }

  function renderGroup(g) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.groupId = String(g.id);

    const swatch = node.querySelector(".swatch");
    if (g.color) swatch.dataset.color = g.color;

    node.querySelector(".title").textContent = g.title;

    const tag = g.allPinned ? "Zen folder" : "tab group";
    node.querySelector(".meta").textContent = `${g.tabCount} · ${tag}`;

    const select = node.querySelector(".sort-mode");
    for (const [key, mode] of Object.entries(SORT_MODES)) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = mode.label;
      select.appendChild(opt);
    }

    node.querySelector(".sort").addEventListener("click", () =>
      runSort(g, select.value)
    );
    node.querySelector(".dedupe").addEventListener("click", () => runDedupe(g));

    return node;
  }

  async function runSort(g, modeKey) {
    const dryRun = dryRunInput.checked;
    setStatus(dryRun ? "Previewing sort…" : "Sorting…");
    const res = await browser.runtime.sendMessage({
      kind: "sort",
      groupId: g.id,
      modeKey,
      dryRun,
    });
    if (res?.dryRun) {
      showSortPreview(g, modeKey, res);
    } else {
      setStatus(formatSort(g.title, res), { success: didSortDoSomething(res) });
      clearPreview();
    }
  }

  async function runDedupe(g) {
    const dryRun = dryRunInput.checked;
    setStatus(dryRun ? "Previewing dedupe…" : "Deduping…");
    const res = await browser.runtime.sendMessage({
      kind: "dedupe",
      groupId: g.id,
      strict: true,
      dryRun,
    });
    if (res?.dryRun) {
      showDedupePreview(g, res);
    } else {
      setStatus(formatDedupe(g.title, res), { success: res.closed > 0 });
      clearPreview();
      if (res.closed > 0) render({ preserveStatus: true });
    }
  }

  function didSortDoSomething(res) {
    return (res?.reordered ?? 0) > 0;
  }

  function showSortPreview(g, modeKey, res) {
    pendingAction = { kind: "sort", group: g, modeKey };
    previewSummary.textContent =
      res.reordered === 0
        ? `"${g.title}" — already sorted (${res.total} tabs).`
        : `"${g.title}" — would move ${plural(res.reordered, "tab", "tabs")} of ${res.total}.`;

    previewList.replaceChildren();
    for (const c of res.changes) {
      const li = document.createElement("li");
      const arrow = document.createElement("span");
      arrow.className = "move-arrow";
      arrow.textContent = `[${c.from}→${c.to}]`;
      li.appendChild(arrow);
      li.appendChild(document.createTextNode(c.title || c.url || "(untitled)"));
      previewList.appendChild(li);
    }
    previewApply.disabled = res.reordered === 0;
    previewEl.hidden = false;
    previewEl.open = true;
    setStatus("Preview ready. Apply or discard.");
  }

  function showDedupePreview(g, res) {
    pendingAction = { kind: "dedupe", group: g };
    const count = res.duplicates.length;
    previewSummary.textContent =
      count === 0
        ? `"${g.title}" — no duplicates (${res.total} checked).`
        : `"${g.title}" — would close ${plural(count, "duplicate", "duplicates")}, keep ${res.total - count}.`;

    previewList.replaceChildren();
    for (const d of res.duplicates) {
      const li = document.createElement("li");
      li.textContent = d.title || d.url || "(untitled)";
      const keeper = document.createElement("span");
      keeper.className = "dup-keeper";
      keeper.textContent = `↳ duplicate of "${d.keeperTitle || d.url}"`;
      li.appendChild(keeper);
      previewList.appendChild(li);
    }
    previewApply.disabled = count === 0;
    previewEl.hidden = false;
    previewEl.open = true;
    setStatus("Preview ready. Apply or discard.");
  }

  async function applyPending() {
    if (!pendingAction) return;
    const { kind, group, modeKey } = pendingAction;
    previewApply.disabled = true;
    setStatus("Applying…");
    const res = await browser.runtime.sendMessage({
      kind,
      groupId: group.id,
      modeKey,
      dryRun: false,
      strict: true,
    });
    if (kind === "sort") {
      setStatus(formatSort(group.title, res), { success: didSortDoSomething(res) });
    } else {
      setStatus(formatDedupe(group.title, res), { success: res?.closed > 0 });
    }
    clearPreview();
    if (kind === "dedupe" && res?.closed > 0) render({ preserveStatus: true });
  }

  function clearPreview() {
    pendingAction = null;
    previewEl.hidden = true;
    previewEl.open = false;
    previewList.replaceChildren();
    previewSummary.textContent = "";
    previewApply.disabled = false;
    // Note: intentionally does NOT touch the status line — callers control that
    // so a success message from a just-completed action survives a re-render.
  }

  function formatSort(title, { reordered, skipped, total, error }) {
    if (!total) return `"${title}": nothing to sort.`;
    if (reordered === 0 && skipped === 0) return `"${title}": already sorted.`;
    if (!skipped) return `"${title}": sorted ${plural(reordered, "tab", "tabs")}.`;
    return `"${title}": sorted ${reordered}, skipped ${skipped}${
      error ? ` (${error})` : ""
    }.`;
  }

  function formatDedupe(title, { closed, kept }) {
    if (closed === 0) return `"${title}": no duplicates (${kept} checked).`;
    return `"${title}": closed ${plural(closed, "duplicate", "duplicates")}, kept ${kept}.`;
  }

  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
  }

  function setStatus(text, opts = {}) {
    // Back-compat: second arg used to be a boolean isError.
    const isError = opts === true || opts.error === true;
    const isSuccess = opts && typeof opts === "object" && opts.success === true;
    statusEl.textContent = text;
    statusEl.classList.toggle("error", isError);
    statusEl.classList.toggle("success", isSuccess);

    // Brief highlight flash so a closing popup still gives a moment of feedback.
    if (isSuccess) {
      statusEl.classList.add("flash");
      clearTimeout(setStatus._flashTimer);
      setStatus._flashTimer = setTimeout(() => {
        statusEl.classList.remove("flash");
      }, 1500);
    } else {
      statusEl.classList.remove("flash");
    }
  }
})();
