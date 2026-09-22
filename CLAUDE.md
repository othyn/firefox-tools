# Firefox Tools

One personal Firefox/Zen extension, merged in September 2026 from three that
were becoming three builds and three toolbar buttons: `reddit-tools`,
`youtube-playlist-tools` and `zen-folder-tools` (all now archived on GitHub).
Nothing was dropped in the merge; the Reddit home-page block was added during it.

There is no bundler, no `package.json` and no dependencies. Keep it that way.

## Layout

```
manifest.json      MV3, Firefox event page (`background.scripts`, not a service worker)
build.sh           Zips to dist/firefox-tools@othyn.com.xpi
test.js            `node --test test.js` — the one check
popup/             The hub, shared by the toolbar action and the options page
reddit/  youtube/  zen/     One directory per area, each owning its own panel
```

## The rule that makes three extensions share one background page

**Every script is wrapped in an IIFE, with two exceptions.** Firefox MV3 content
scripts cannot be ES modules, and `reddit/settings.js` is one, so the whole
extension is classic scripts sharing a global scope — the background page and
the popup page each load files from all three areas at once.

The two exceptions publish, deliberately:

- `reddit/settings.js` — `DEFAULTS`, `TOGGLES`, `SORT_OPTIONS`, `VALID_SORTS`,
  `ext`, `commentSortUrl()`, `isBlockedHome()`, `offTokens()`, `loadSettings()`,
  `saveSettings()`. Listed first everywhere it is needed.
- `zen/lib/folder-tools.js` — exactly one name, `globalThis.FolderTools`. It was
  an ES module before the merge; the `export`s became that object.

Anything else that needs sharing goes through one of those two. Without the
rule the background page fails to *parse*: `reddit/settings.js` and
`youtube/background.js` both want a top-level `const DEFAULTS`, and the Reddit
and Folders panels both want a `render`. Two `const`s of one name in the shared
global lexical scope is a `SyntaxError`, not a subtle bug — so a merge conflict
here takes down all three areas at once, which is worth knowing when something
that used to work stops working everywhere simultaneously.

`youtube/content.js` and `youtube/linkding-badges.js` were already IIFEs and
were left alone.

## The popup is a hub

One toolbar button, so one popup: `popup/popup.html` holds a tab strip over
three `<section class="panel">`, and `popup/popup.js` does nothing but decide
which one is visible — it opens on Reddit for a `reddit.com` tab, YouTube for a
`youtube.com` tab, and Folders for everything else, because tab groups exist on
every page. Each panel's own `panel.js` owns its controls and knows nothing
about the others.

`options_ui.page` points at the same file. That is why there is no separate
options page: the old one was a byte-for-byte copy of the popup body. In the
`about:addons` embed the active tab is `about:addons`, so it opens on Folders
and YouTube's playlist-only buttons are disabled — the same thing that happens
in the popup on any non-playlist page.

**Element ids are global across the merged page.** `zen/panel.js` reads
`#zen-status` rather than the `#status` it used before the merge, because the
YouTube panel already owns `#status`. Check for a clash before adding an id.

**One stylesheet, not three.** All three popups were variations on the same
primitives (`.row`, `.switch`, `.group`, `.actions`, `.status`) with different
numbers, so `popup/popup.css` defines those once and scopes only the genuinely
bespoke parts under `#panel-reddit`, `#panel-youtube` and `#panel-zen`. Prefer
extending a primitive to adding a panel-scoped override.

## Reddit

| Feature | Storage key | Mechanism |
|---|---|---|
| Default comment sort | `sort` | Blocking `webRequest` redirect on full loads; click-time href rewrite for shreddit's client-side routing |
| Block the front page and feeds | `blockHome` | Same blocking redirect, to `reddit/blocked.html`; click interception for client-side routes |
| Hide both sidebars, the search box, Sign Up / Log In | `declutter` | CSS |
| Hide the comment composer, per-comment Reply / Award / Share, promoted posts | `hideInert` | CSS |
| Full-width, flush-left content with post media capped | `wideContent` | CSS |
| Reddit logo returns to the current subreddit, not the front page | `logoToSubreddit` | Click-time href rewrite |
| Open posts in a new tab | `commentsNewTab` | Click interception |
| Master switch | `enabled` | Gates all of the above |

All settings live in `browser.storage.sync`. `DEFAULTS` and the sanitisation
rules are in `reddit/settings.js`; everything defaults to on, and `sort` defaults
to `top`.

### 1. The CSS gate is inverted

`reddit/reddit.css` ships declaratively in `content_scripts.css` at
`document_start`, and every rule is scoped to the feature being **off**:

```css
html:not([data-rt-off~="declutter"]) #left-sidebar-container { display: none !important; }
```

`content.js` writes `data-rt-off` with the tokens for the features that are
disabled, after its async storage read. The point is that the enabled path — the
common one — needs no JS at all and so never flashes. Gating the normal way round
(`html[data-rt-on] …`) would show the sidebars for a frame on every page load.
The disabled path briefly hides an element before revealing it, which is the
harmless direction.

Token names live next to their feature keys in `TOGGLES`, and `offTokens()` is
the only thing that computes the attribute value.

### 2. Selectors are verified against the live DOM, never guessed

Reddit's class names are Tailwind build output (`.m\:w-\[560px\]`, `.nd\:visible`)
and churn on every deploy. Every selector in `reddit.css` therefore hangs off an
id, a custom element name, or a semantic attribute:

`#left-sidebar-container`, `#right-sidebar-container`, `reddit-search-large`,
`#navbar-menu-button`, `#signup-button`, `#login-button`, `#reddit-logo`,
`#expand-user-drawer-button` (the three-dot menu — keep it), `.grid-container`,
`#subgrid-container`, `.main-container`, `shreddit-post > [slot="post-media-container"]`,
`comment-body-header > faceplate-tracker[source="shreddit_comment_count_button"]`,
`shreddit-comment-action-row > [slot="comment-reply"|"comment-award"|"comment-share"]`,
`shreddit-ad-post`, `shreddit-sidebar-ad`.

When something breaks, do not guess a replacement. Drive the page with cmux
(`~/.claude/skills/oth-cmux/SKILL.md`) and read the real DOM:

```bash
cmux browser open-split "https://www.reddit.com/r/apple/" --focus false
S=surface:N
cmux browser --surface "$S" viewport 1800 1000
cmux browser --surface "$S" eval '<inspection js>'
```

Reddit serves a JS challenge to automation; the cmux browser clears it, plain
`curl` does not. At narrow viewports the desktop breakpoints are inactive and the
layout will mislead you — set a wide viewport before measuring. Verify a
candidate rule by injecting it as a `<style>` via `eval`, then screenshot, before
committing it to `reddit.css`.

### Layout notes worth not re-deriving

- `.grid-container` reserves a 315px column for the left nav, which is
  `position: fixed`, so it must be both hidden and have its gutter collapsed.
- `#subgrid-container` is where both the 1120px cap and the `mx-auto` centring
  live.
- `.main-container` reserves 316px for the right sidebar.
- `--rt-media-max` is 756px because that is Reddit's own content column ceiling
  (`minmax(0,756px)`), so capping post media there keeps images at exactly the
  size they render at today.

### Comment sort values

Verified against the live shreddit sort dropdown on 11 September 2026 — the
values are unchanged from Old Reddit, "Best" included, which is `confidence` and
not `best`.

`off` (leave Reddit's default alone), `confidence`, `top`, `new`,
`controversial`, `old`, `qa`.

`commentSortUrl()` skips any URL that already carries a `sort` param. That is
load-bearing twice: it lets Reddit's own dropdown win, and it is the loop-breaker
for the blocking redirect, which re-enters the listener with the stamped URL.

`isBlockedHome()` needs no such loop-breaker — its redirect target is a
`moz-extension:` URL, which falls outside the listener's `urls` filter. It
matches `r/all` and `r/popular` as *prefixes*, so `/r/all/top` is caught, with a
boundary so `r/allotments` is not. That boundary is the reason `test.js` exists
for this function.

### Why there is no MutationObserver

shreddit is a client-side-routed SPA, so the obvious approach is to observe the
DOM and re-apply on every mutation. It is not needed. A single capture-phase
`click` listener on `document` reads `location` and the live settings at click
time, which is correct across any amount of client-side navigation, and CSS
applies to nodes Reddit adds later for free. Keep the interaction layer to that
one listener.

`commentsNewTab` deliberately goes around shreddit's router with
`preventDefault()` + `window.open()`, because the router ignores `target`. The
new tab full-loads, which is what lets `background.js` stamp the sort.

The home block rides on the same listener, and carries a `ponytail:` marker
because of it: clicks and full loads are covered, a route to the front page by
some other means is not.

## YouTube

The background page is the only context allowed to talk to Linkding — a
content-script fetch would run as `https://www.youtube.com` and be CORS-blocked.
It publishes the saved-video id set to the content scripts through
`storage.local`, which repaints them via `storage.onChanged`, so no `tabs`
broadcasting is involved. It is an event page and is unloaded when idle; the
cache is the source of truth and is re-read on every wake.

Settings live in `storage.local` under `ytPlaylistTools.config`, not in the
top-level `storage.sync` keys Reddit uses. Nothing collides, and both areas were
left exactly as they were.

The Linkding host permission is optional and is requested inside the user
gesture that enables the feature — keep the first `await` in that handler after
the `permissions.request()` call, or the gesture is lost.

## Folders

`zen/lib/folder-tools.js` is pure logic over `browser.tabs` / `browser.tabGroups`
and is shared by the tab right-click menu (`zen/background.js`) and the panel.
`tabGroups` is why `strict_min_version` is 139.0.

Dedupe compares canonicalised URLs: known noise params (`utm_*`, `list`, `index`,
`si`, `fbclid`, …) are stripped, everything else is kept exact, so a video opened
from a playlist and the same video opened alone dedupe together while `?v=` and
`?q=` stay meaningful.

## Build and install

```bash
./build.sh                 # -> dist/firefox-tools@othyn.com.xpi
node --test test.js        # the one check
npx web-ext lint --source-dir .   # occasionally, before a manifest change lands
```

The xpi filename must stay `firefox-tools@othyn.com.xpi` (the gecko id) for the
Zen/Firefox profile drop-in install. `build.sh` excludes `build.sh`, `test.js`
and `*.md`, so documentation never ships in the package — add any new
development-only file to that exclude list.

For a throwaway load, `about:debugging#/runtime/this-firefox`. For a
restart-surviving install, `zen-ext install firefox-tools` from `dotfiles/bin`.

## House style

British English in comments, docs and commit messages. Reddit's, YouTube's and
the WebExtension API's own identifiers keep their spelling. Prefer deleting code
to adding it; there is no build step to hide complexity behind.

Non-trivial logic leaves one runnable check behind in `test.js`. Deliberate
shortcuts get a `ponytail: <ceiling>, <upgrade path>` comment.
