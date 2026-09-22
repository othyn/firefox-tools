# Firefox Tools

A single personal Firefox/Zen extension holding three sets of browser fixes that
used to be three separate add-ons: **Reddit**, **YouTube** and **Folders**.

It is never going to be listed on addons.mozilla.org — the behaviour is tuned to
one person's habits. One extension means one build, one XPI and one toolbar
button instead of three.

It replaces [`reddit-tools`](https://github.com/othyn/reddit-tools),
[`youtube-playlist-tools`](https://github.com/othyn/youtube-playlist-tools) and
[`zen-folder-tools`](https://github.com/othyn/zen-folder-tools), all now
archived.

---

## Reddit

Makes New Reddit (shreddit) bearable while logged out. Every feature is a switch
in the popup, and all of them are on by default.

- **Default comment sort** — comment pages open on your chosen sort. Links that
  already specify a sort are left alone, so Reddit's own dropdown still wins.
- **Hide sidebars and navbar** — both sidebars go, along with the search box and
  the Sign Up / Log In buttons. The Reddit logo and the three-dot menu stay.
- **Hide dead controls** — the comment box, and Reply / Award / Share on each
  comment, none of which do anything without an account. Votes and the comment
  overflow menu stay. Promoted posts go too.
- **Full-width content** — content fills the window, flush left, the way Old
  Reddit did. Post images, video and galleries keep their current size.
- **Block the home page** — the front page, `/best`, `/hot`, `/new`, `/top`,
  `/rising`, `r/all` and `r/popular` are replaced with a block page. There is
  deliberately no way past it other than turning the switch off. Subreddits,
  posts, users and search are untouched.
- **Logo returns to the subreddit** — the Reddit logo goes back to the subreddit
  you are reading rather than the global front page.
- **Open posts in a new tab** — clicking a post in a listing opens its comments
  in a new tab.

### Comment sort values

| Label | `sort` value |
|---|---|
| Reddit default | `off` (nothing is added to the URL) |
| Best | `confidence` |
| Top | `top` *(default)* |
| New | `new` |
| Controversial | `controversial` |
| Old | `old` |
| Q&A | `qa` |

## YouTube

A toolkit for playlists and links, driven from the popup.

- **Bulk delete** — removes videos from a playlist across YouTube's virtualised
  list, with configurable delays, a watched-percentage threshold, periodic
  pauses and an optional shuffle. Progress and pause are live in the popup.
- **Export list** — saves every video in the open playlist as JSON (URL, title,
  author), ready for `/oth:yt-linkding` to archive into Linkding, auto-tagged.
- **Clean links** — strips `&list` / `&index` from video links and forces clean
  new-tab opens.
- **Linkding badges** — badges thumbnails whose video is already saved in your
  Linkding instance. The saved-video set is fetched by the background page,
  which is the only context that can reach Linkding without tripping CORS, and
  published to the content scripts through `storage.local`.

## Folders

Sorts and dedupes the contents of Zen Browser sidebar folders and Firefox tab
groups, from the popup or a tab right-click.

- **Sort** — by title (either direction), by domain then title, or by last used
  (either direction).
- **Dedupe** — closes duplicate tabs, keeping the oldest. Tracking and playlist
  query params (`utm_*`, `list`, `index`, `si`, …) are ignored when comparing,
  so the same video opened from a playlist and on its own count as one.
- **Dry run** — previews exactly what sort or dedupe would do, with an Apply
  button, before anything moves or closes.

---

## Install (temporary)

`about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick
`manifest.json`. Temporary add-ons are removed when the browser restarts.

## Install (permanent)

Build an `.xpi` — it lands at `dist/<gecko-id>.xpi`, named for the id in
`manifest.json`, which is what the browser keys the install on:

```bash
./build.sh
```

Then either:

- **Unsigned** — set `xpinstall.signatures.required` to `false` in
  `about:config`, then `about:addons` → ⚙ → **Install Add-on From File…** and
  pick the `.xpi`. This works on Zen and on any Firefox build compiled without
  `MOZ_REQUIRE_SIGNING`; on stock Firefox release the pref is inert, so use the
  signed route there.
- **Signed** — submit the `.xpi` to
  [addons.mozilla.org](https://addons.mozilla.org/developers/) as an unlisted
  add-on (`web-ext sign --channel=unlisted`) and install the signed file. No
  prefs needed, and supports auto-updates.

For my own machine, [`zen-ext`](https://github.com/othyn/dotfiles) (in
`dotfiles/bin`) runs `build.sh` and drops the `.xpi` straight into the Zen
profile's `extensions/` directory.

## How it works

```
manifest.json      MV3, one Firefox event page, one toolbar action, three content-script entries
popup/             The hub: a tab strip over three panels, opening on the one that matches the page
reddit/            settings.js (shared globals) · background.js (blocking webRequest)
                   content.js (CSS gate + one click listener) · reddit.css · blocked.* · panel.js
youtube/           background.js (Linkding fetch + cache) · content.js (delete engine)
                   linkding-badges.js · panel.js
zen/               lib/folder-tools.js (pure sort/dedupe) · background.js (tab menu) · panel.js
test.js            node --test test.js — no dependencies
```

There is no bundler, no `package.json` and no dependencies. Scripts share what
little they need through ordinary `<script>` tags. See `CLAUDE.md` for the
conventions that keeps workable.

## Tests

```bash
node --test test.js
```

Covers `commentSortUrl()` — including the "already sorted" case that stops the
blocking redirect looping — and `isBlockedHome()`, including the `r/all` prefix
that must not swallow `r/allotments`.
