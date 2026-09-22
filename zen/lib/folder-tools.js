// Pure sort/dedupe logic, shared by the background page and the Folders panel.
// Publishes exactly one global, `FolderTools` — see CLAUDE.md. It used to be an
// ES module, but Firefox MV3 content scripts cannot be modules and the Reddit
// half needs classic scripts, so the whole extension is classic.
(() => {
  "use strict";

  // All functions take a "tab group id" (number) and operate via browser.tabs / browser.tabGroups.

  const SORT_MODES = {
    titleAsc: {
      label: "Title A→Z",
      cmp: (a, b) => collator.compare(a.title ?? "", b.title ?? ""),
    },
    titleDesc: {
      label: "Title Z→A",
      cmp: (a, b) => collator.compare(b.title ?? "", a.title ?? ""),
    },
    domain: {
      label: "Domain, then title",
      cmp: (a, b) => {
        const h = collator.compare(hostOf(a), hostOf(b));
        return h !== 0 ? h : collator.compare(a.title ?? "", b.title ?? "");
      },
    },
    recentFirst: {
      label: "Recently used first",
      cmp: (a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0),
    },
    oldestFirst: {
      label: "Recently used last",
      cmp: (a, b) => (a.lastAccessed ?? 0) - (b.lastAccessed ?? 0),
    },
  };

  const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

  function hostOf(tab) {
    try {
      return new URL(tab.url ?? "").hostname;
    } catch {
      return "";
    }
  }

  async function listGroups() {
    if (!browser.tabGroups?.query) return [];
    const groups = await browser.tabGroups.query({});
    // Annotate each group with tab count and whether every tab is pinned (Zen folder heuristic).
    const annotated = await Promise.all(
      groups.map(async g => {
        const tabs = await browser.tabs.query({ groupId: g.id });
        return {
          id: g.id,
          title: g.title || "(untitled)",
          color: g.color,
          collapsed: g.collapsed,
          tabCount: tabs.length,
          allPinned: tabs.length > 0 && tabs.every(t => t.pinned),
        };
      })
    );
    annotated.sort((a, b) => collator.compare(a.title, b.title));
    return annotated;
  }

  async function sortGroup(groupId, modeKey, { dryRun = false } = {}) {
    const mode = SORT_MODES[modeKey];
    if (!mode) throw new Error(`unknown sort mode: ${modeKey}`);
    const tabs = await browser.tabs.query({ groupId });
    if (tabs.length < 2) {
      return { dryRun, total: tabs.length, reordered: 0, skipped: 0, changes: [] };
    }

    const sorted = tabs.slice().sort(mode.cmp);
    const startIndex = Math.min(...tabs.map(t => t.index));

    const changes = sorted
      .map((tab, i) => ({
        id: tab.id,
        title: tab.title ?? "",
        url: tab.url ?? "",
        from: tab.index,
        to: startIndex + i,
      }))
      .filter(c => c.from !== c.to);

    if (dryRun) {
      return {
        dryRun: true,
        total: tabs.length,
        reordered: changes.length,
        skipped: 0,
        changes,
      };
    }

    if (changes.length === 0) {
      return { dryRun: false, total: tabs.length, reordered: 0, skipped: 0, changes: [] };
    }

    // Fast path: move all in one call.
    try {
      await browser.tabs.move(
        sorted.map(t => t.id),
        { index: startIndex }
      );
      return {
        dryRun: false,
        total: tabs.length,
        reordered: changes.length,
        skipped: 0,
        changes,
      };
    } catch (bulkErr) {
      // Slow path: move one by one, count failures.
      let reordered = 0;
      let skipped = 0;
      let lastError = null;
      for (let i = 0; i < sorted.length; i++) {
        try {
          await browser.tabs.move(sorted[i].id, { index: startIndex + i });
          reordered++;
        } catch (e) {
          skipped++;
          lastError = e;
        }
      }
      return {
        dryRun: false,
        total: tabs.length,
        reordered,
        skipped,
        changes,
        error: lastError?.message,
      };
    }
  }

  async function dedupeGroup(groupId, { strict = true, dryRun = false } = {}) {
    const tabs = await browser.tabs.query({ groupId });
    if (tabs.length < 2) {
      return { dryRun, total: tabs.length, closed: 0, kept: tabs.length, duplicates: [] };
    }

    const ordered = tabs.slice().sort((a, b) => a.index - b.index);
    const seen = new Map();
    const duplicates = [];
    for (const tab of ordered) {
      const key = canonicalUrl(tab.url, { strict });
      if (!key) continue;
      const keeper = seen.get(key);
      if (keeper) {
        duplicates.push({
          id: tab.id,
          title: tab.title ?? "",
          url: tab.url ?? "",
          keeperId: keeper.id,
          keeperTitle: keeper.title ?? "",
        });
      } else {
        seen.set(key, tab);
      }
    }

    if (dryRun || duplicates.length === 0) {
      return {
        dryRun,
        total: tabs.length,
        closed: 0,
        kept: tabs.length - (dryRun ? duplicates.length : 0),
        wouldClose: dryRun ? duplicates.length : undefined,
        duplicates,
      };
    }

    await browser.tabs.remove(duplicates.map(d => d.id));
    return {
      dryRun: false,
      total: tabs.length,
      closed: duplicates.length,
      kept: tabs.length - duplicates.length,
      duplicates,
    };
  }

  // Query params that are navigation/sharing noise rather than content identity.
  // Stripping these makes e.g. a YouTube video opened on its own and the same
  // video opened from a playlist (…&list=WL&index=140) dedupe together, while
  // meaningful params (?v=, ?q=, …) are preserved.
  const NOISE_PARAMS = new Set([
    // YouTube playlist / queue context
    "list", "index", "start_radio", "pp", "ab_channel",
    // Generic sharing / referral
    "si", "feature", "ref", "ref_src", "ref_url", "source",
    // Click/marketing trackers
    "fbclid", "gclid", "dclid", "gbraid", "wbraid", "msclkid", "igshid", "igsh",
    "mc_cid", "mc_eid", "spm",
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  ]);

  function canonicalUrl(url, { strict }) {
    if (!url) return "";
    try {
      const u = new URL(url);
      if (strict) {
        // Strip only known noise params; keep everything else exact.
        for (const key of [...u.searchParams.keys()]) {
          if (NOISE_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
        }
        return u.toString();
      }
      // Loose mode: drop all query params and the hash entirely.
      u.hash = "";
      u.search = "";
      return u.toString();
    } catch {
      return url;
    }
  }

  async function findGroupForTab(tabId) {
    const tab = await browser.tabs.get(tabId);
    if (!tab || tab.groupId == null || tab.groupId === -1) return null;
    try {
      return await browser.tabGroups.get(tab.groupId);
    } catch {
      return { id: tab.groupId, title: "" };
    }
  }

  globalThis.FolderTools = {
    SORT_MODES,
    listGroups,
    sortGroup,
    dedupeGroup,
    findGroupForTab,
  };
})();
