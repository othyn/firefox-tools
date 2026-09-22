// Use the standard `browser.*` promise API; fall back to `chrome`, and to
// nothing at all outside a browser so `test.js` can require this file in node.
const ext =
  typeof browser !== "undefined" ? browser :
  typeof chrome !== "undefined" ? chrome :
  undefined;

const DEFAULTS = {
  enabled: true,
  sort: "top",
  commentsNewTab: true,
  declutter: true,
  hideInert: true,
  wideContent: true,
  logoToSubreddit: true,
  blockHome: true
};

// Every switch in the popup, in display order. `token` names the gate this
// feature writes into `data-rt-off` for reddit.css; a feature with no token is
// driven by content.js alone. `enabled` is the master and gates all the rest.
const TOGGLES = [
  { key: "enabled", token: null },
  { key: "declutter", token: "declutter" },
  { key: "hideInert", token: "inert" },
  { key: "wideContent", token: "wide" },
  { key: "logoToSubreddit", token: null },
  { key: "commentsNewTab", token: null },
  { key: "blockHome", token: null }
];

// UI label -> New Reddit `sort` query value. Verified against the live
// shreddit sort dropdown on 11 September 2026: the values are unchanged from
// Old Reddit, "Best" included, which is `confidence` rather than `best`.
const SORT_OPTIONS = [
  { value: "off", label: "Reddit default" },
  { value: "confidence", label: "Best" },
  { value: "top", label: "Top" },
  { value: "new", label: "New" },
  { value: "controversial", label: "Controversial" },
  { value: "old", label: "Old" },
  { value: "qa", label: "Q&A" }
];

const VALID_SORTS = new Set(SORT_OPTIONS.map((o) => o.value));

// The one place a comment URL gets its sort stamped. Shared by background.js
// (full page loads) and content.js (clicks shreddit would otherwise route
// client-side), so the two can never disagree.
function commentSortUrl(rawUrl, sort) {
  if (!sort || sort === "off") return null;

  let url;
  try {
    url = new URL(rawUrl, typeof location !== "undefined" ? location.href : undefined);
  } catch (e) {
    return null;
  }

  if (url.hostname !== "reddit.com" && !url.hostname.endsWith(".reddit.com")) return null;
  if (!url.pathname.includes("/comments/")) return null;

  // Load-bearing twice over: it lets Reddit's own sort dropdown win, and it is
  // the loop-breaker for the blocking webRequest redirect, which re-enters the
  // listener with the stamped URL.
  if (url.searchParams.has("sort")) return null;

  url.searchParams.set("sort", sort);
  return url.toString();
}

// Reddit's algorithmic feeds — every path that drops you into a firehose rather
// than a specific subreddit, post, user or search. r/all and r/popular are
// matched as prefixes so their sort suffixes (/r/all/top) are caught too, but
// the boundary keeps r/allotments out of it.
const HOME_PATHS = new Set(["/", "/best", "/hot", "/new", "/top", "/rising"]);

function isBlockedHome(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl, typeof location !== "undefined" ? location.href : undefined);
  } catch (e) {
    return false;
  }

  if (url.hostname !== "reddit.com" && !url.hostname.endsWith(".reddit.com")) return false;

  const path = url.pathname.replace(/\/+$/, "").toLowerCase() || "/";
  return HOME_PATHS.has(path) || /^\/r\/(all|popular)(\/|$)/.test(path);
}

// Gate tokens for the features that are *off*, so reddit.css can hide things
// with no JS on the enabled path. See CLAUDE.md for why the gate is inverted.
function offTokens(settings) {
  return TOGGLES
    .filter((t) => t.token && (!settings.enabled || settings[t.key] === false))
    .map((t) => t.token);
}

async function loadSettings() {
  const stored = await ext.storage.sync.get(DEFAULTS);
  const settings = { sort: VALID_SORTS.has(stored.sort) ? stored.sort : DEFAULTS.sort };
  for (const { key } of TOGGLES) settings[key] = stored[key] !== false;
  return settings;
}

async function saveSettings(partial) {
  await ext.storage.sync.set(partial);
}

if (typeof module !== "undefined") {
  module.exports = {
    commentSortUrl, isBlockedHome, offTokens,
    DEFAULTS, TOGGLES, SORT_OPTIONS, VALID_SORTS
  };
}
