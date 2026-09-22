// Extension pages run under `script-src 'self'`, so this cannot be inline.
(() => {
  "use strict";

  // [headline, subtitle]
  const LINES = [
    ["Not today.", "You came here by accident. This is the accident being caught."],
    ["The feed is closed.", "Everything on it would have annoyed you within ninety seconds."],
    ["Wrong turn.", "There is no front page. There is only the subreddit you actually wanted."],
    ["You do not want this.", "Past you set up a redirect specifically to tell present you that."],
    ["Nothing here has changed.", "It is the same six arguments it was this morning."],
    ["Denied, with love.", "Go and type the name of a subreddit like a person with intent."],
    ["That was muscle memory.", "Muscle memory is not the same thing as wanting something."],
    ["Doomscroll cancelled.", "Consider a kettle instead."],
  ];

  const [line, sub] = LINES[Math.floor(Math.random() * LINES.length)];
  document.getElementById("line").textContent = line;
  document.getElementById("sub").textContent = sub;
})();
