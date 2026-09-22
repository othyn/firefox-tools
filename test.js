// The one runnable check: `node --test test.js`. No dependencies.
//
// Both functions under test are pure URL predicates that decide whether a
// page load gets redirected, and both have an edge that matters: commentSortUrl's
// "already has a sort" early return is what stops the blocking webRequest
// redirect looping forever, and isBlockedHome's r/all prefix must not swallow
// r/allotments.
const { test } = require("node:test");
const assert = require("node:assert");
const { commentSortUrl, isBlockedHome } = require("./reddit/settings.js");

const POST = "https://www.reddit.com/r/apple/comments/1wdai22/the_hole_punch/";

test("stamps the sort on a bare comment URL", () => {
  assert.strictEqual(commentSortUrl(POST, "top"), POST + "?sort=top");
});

test("leaves an existing sort alone, which is also the redirect loop-breaker", () => {
  assert.strictEqual(commentSortUrl(POST + "?sort=new", "top"), null);
});

test("does nothing when the sort is off", () => {
  assert.strictEqual(commentSortUrl(POST, "off"), null);
  assert.strictEqual(commentSortUrl(POST, ""), null);
  assert.strictEqual(commentSortUrl(POST, undefined), null);
});

test("ignores paths that are not comment pages", () => {
  assert.strictEqual(commentSortUrl("https://www.reddit.com/r/apple/", "top"), null);
});

test("ignores hosts that are not reddit, including lookalikes", () => {
  assert.strictEqual(commentSortUrl("https://example.com/r/a/comments/b/c/", "top"), null);
  assert.strictEqual(commentSortUrl("https://notreddit.com/r/a/comments/b/c/", "top"), null);
  assert.strictEqual(commentSortUrl("https://evil-reddit.com/r/a/comments/b/c/", "top"), null);
});

test("accepts every reddit subdomain and the bare apex", () => {
  for (const host of ["reddit.com", "www.reddit.com", "sh.reddit.com"]) {
    assert.strictEqual(
      commentSortUrl(`https://${host}/r/a/comments/b/c/`, "new"),
      `https://${host}/r/a/comments/b/c/?sort=new`
    );
  }
});

test("preserves other query params and the hash", () => {
  assert.strictEqual(
    commentSortUrl(POST + "?utm_source=x#p94aen8", "qa"),
    POST + "?utm_source=x&sort=qa#p94aen8"
  );
});

test("returns null rather than throwing on an unparseable URL", () => {
  assert.strictEqual(commentSortUrl("not a url", "top"), null);
});

// ---------------------------------------------------------------------------
// isBlockedHome

test("blocks the front page, with or without a trailing slash", () => {
  for (const url of [
    "https://www.reddit.com/",
    "https://www.reddit.com",
    "https://reddit.com/",
    "https://sh.reddit.com/"
  ]) {
    assert.strictEqual(isBlockedHome(url), true, url);
  }
});

test("blocks the front-page feed aliases", () => {
  for (const path of ["/best", "/hot", "/new", "/top/", "/rising"]) {
    assert.strictEqual(isBlockedHome("https://www.reddit.com" + path), true, path);
  }
});

test("blocks r/all and r/popular, including their sort suffixes", () => {
  for (const path of ["/r/all", "/r/all/", "/r/all/top", "/r/popular", "/r/popular/new"]) {
    assert.strictEqual(isBlockedHome("https://www.reddit.com" + path), true, path);
  }
});

test("leaves a subreddit whose name merely starts with all alone", () => {
  assert.strictEqual(isBlockedHome("https://www.reddit.com/r/allotments/"), false);
  assert.strictEqual(isBlockedHome("https://www.reddit.com/r/popularscience/"), false);
});

test("leaves everything that is not a feed alone", () => {
  for (const path of ["/r/apple/", "/user/spez", "/search?q=x", POST.slice("https://www.reddit.com".length)]) {
    assert.strictEqual(isBlockedHome("https://www.reddit.com" + path), false, path);
  }
});

test("ignores non-reddit hosts and unparseable URLs", () => {
  assert.strictEqual(isBlockedHome("https://example.com/"), false);
  assert.strictEqual(isBlockedHome("https://evil-reddit.com/"), false);
  assert.strictEqual(isBlockedHome("not a url"), false);
});

test("matches case-insensitively, the way Reddit routes", () => {
  assert.strictEqual(isBlockedHome("https://www.reddit.com/Hot"), true);
  assert.strictEqual(isBlockedHome("https://www.reddit.com/r/All"), true);
});

// ---------------------------------------------------------------------------
// Script scoping
//
// The background page and the popup each load files from all three areas into
// one shared global scope. Two top-level `const`s of the same name there is a
// SyntaxError that takes down every feature at once, so compiling each context's
// scripts together is the check that the IIFE convention in CLAUDE.md holds.
// Concatenation is a fair proxy: separate <script> elements share the same
// global lexical scope, and redeclaring across them fails identically.

const fs = require("node:fs");
const vm = require("node:vm");
const manifest = require("./manifest.json");

const CONTEXTS = {
  "background page": manifest.background.scripts,
  "popup page": [
    "popup/popup.js",
    "reddit/settings.js",
    "reddit/panel.js",
    "youtube/panel.js",
    "zen/lib/folder-tools.js",
    "zen/panel.js"
  ],
  ...Object.fromEntries(
    manifest.content_scripts.map((cs, i) => [`content script ${i}`, cs.js])
  )
};

for (const [context, files] of Object.entries(CONTEXTS)) {
  test(`${context} scripts share a global scope without colliding`, () => {
    const source = files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
    assert.doesNotThrow(() => new vm.Script(source, { filename: context }));
  });
}

test("the popup loads every script the manifest's contexts rely on", () => {
  const html = fs.readFileSync("popup/popup.html", "utf8");
  const path = require("node:path");
  const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) =>
    path.posix.normalize(path.posix.join("popup", m[1]))
  );
  assert.deepStrictEqual(srcs, CONTEXTS["popup page"]);
});
