// Tab right-click menu for folder sort/dedupe, plus the message handler the
// Folders panel calls. `FolderTools` is published by zen/lib/folder-tools.js,
// which is listed before this file in manifest.background.scripts.
(() => {
  "use strict";

  const { SORT_MODES, sortGroup, dedupeGroup, findGroupForTab } = FolderTools;

  const PARENT_ID = "zft-tab-parent";
  const SORT_PREFIX = "zft-sort-";
  const DEDUPE_ID = "zft-dedupe";

  function buildContextMenu() {
    browser.menus.create({
      id: PARENT_ID,
      title: "Folder tools",
      contexts: ["tab"],
    });

    for (const [key, mode] of Object.entries(SORT_MODES)) {
      browser.menus.create({
        id: `${SORT_PREFIX}${key}`,
        parentId: PARENT_ID,
        title: `Sort: ${mode.label}`,
        contexts: ["tab"],
      });
    }

    browser.menus.create({
      id: "zft-sep",
      parentId: PARENT_ID,
      type: "separator",
      contexts: ["tab"],
    });

    browser.menus.create({
      id: DEDUPE_ID,
      parentId: PARENT_ID,
      title: "Dedupe (ignore tracking params, keep oldest)",
      contexts: ["tab"],
    });
  }

  browser.runtime.onInstalled.addListener(buildContextMenu);
  browser.runtime.onStartup.addListener(buildContextMenu);

  browser.menus.onShown.addListener(async (info, tab) => {
    // Hide the submenu entirely when the tab isn't in a group.
    const visible = tab?.groupId != null && tab.groupId !== -1;
    await browser.menus.update(PARENT_ID, { visible });
    browser.menus.refresh();
  });

  browser.menus.onClicked.addListener(async (info, tab) => {
    if (!tab) return;
    const group = await findGroupForTab(tab.id);
    if (!group) {
      await notify("This tab isn't in a folder or tab group.");
      return;
    }

    if (info.menuItemId === DEDUPE_ID) {
      const { closed, kept } = await dedupeGroup(group.id);
      await notify(formatDedupe(group.title, closed, kept));
      return;
    }

    if (typeof info.menuItemId === "string" && info.menuItemId.startsWith(SORT_PREFIX)) {
      const modeKey = info.menuItemId.slice(SORT_PREFIX.length);
      const result = await sortGroup(group.id, modeKey);
      await notify(formatSort(group.title, result));
    }
  });

  // Messages from the popup. The popup renders its own success UI inline, so we
  // don't emit system notifications here — those are reserved for tab-context-menu
  // actions where there's no other surface to report back on.
  //
  // Deliberately not `async`: an async listener always returns a promise, which
  // tells the browser "I will answer this" for *every* message on the shared
  // background page, including the YouTube half's. That promise resolves to
  // undefined immediately and so beats any listener doing real work, and the
  // sender gets nothing back. Returning the promise only for the kinds we own
  // leaves the rest undefined, which is how a listener declines a message.
  browser.runtime.onMessage.addListener(msg => {
    if (msg?.kind === "sort") {
      return sortGroup(msg.groupId, msg.modeKey, { dryRun: !!msg.dryRun });
    }
    if (msg?.kind === "dedupe") {
      return dedupeGroup(msg.groupId, {
        strict: msg.strict ?? true,
        dryRun: !!msg.dryRun,
      });
    }
  });

  function formatSort(groupTitle, { reordered, skipped, total, error }) {
    const name = groupTitle ? `"${groupTitle}"` : "folder";
    if (total === 0) return `${name}: nothing to sort.`;
    if (skipped === 0) return `${name}: sorted ${plural(reordered, "tab", "tabs")}.`;
    return `${name}: sorted ${reordered}, skipped ${skipped}${
      error ? ` (${error})` : ""
    }.`;
  }

  function formatDedupe(groupTitle, closed, kept) {
    const name = groupTitle ? `"${groupTitle}"` : "folder";
    if (closed === 0) return `${name}: no duplicates (${kept} checked).`;
    return `${name}: closed ${plural(closed, "duplicate", "duplicates")}, kept ${kept}.`;
  }

  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
  }

  async function notify(message) {
    // Light-weight: title + body in a single notification.
    try {
      await browser.notifications?.create?.({
        type: "basic",
        iconUrl: browser.runtime.getURL("icons/icon.svg"),
        title: "Zen Folder Tools",
        message,
      });
    } catch {
      // Fall back to console — popup users see the result inline anyway.
      console.info("[zen-folder-tools]", message);
    }
  }
})();
