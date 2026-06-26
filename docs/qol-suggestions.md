# QOL improvement suggestions

> A living list of quality-of-life ideas found while navigating the app live and
> reading the code. Bugs that have an actual fix go into commits/tests; this file
> is for smaller UX papercuts and "would be nice" improvements. Tagged by area and
> rough effort. Newest at the top of each section.

## Sessions / workspace tabs

- **Sleeping (idle-evicted) sessions vanish from the tab strip.** `liveSessions()`
  only returns keys that still hold a running engine, so after the 5-min idle
  eviction (or the memory backstop) a session disappears from the workspace tabs
  even though its transcript is kept and it can cold-resume. To the user this looks
  like "my session disappeared." Suggestion: keep evicted-but-known sessions in the
  tab strip rendered as *sleeping* (dimmed, "💤"), and cold-resume them on tap.
  *(Med — needs the SESSIONS event to carry sleeping sessions, not just live ones.)*
- **No visible confirmation when a new tab is created vs. when it merges.** A brief
  toast ("New session started") would make the multi-session model legible.  *(Low)*

## Transcript / rendering

- **Finished thinking traces stay expanded.** *(Live-confirmed at phone size.)*
  After a turn the "Thought process" card stays open and eats ~⅓ of the viewport on
  multi-turn conversations. Consider auto-collapsing a thinking card once its reply
  starts streaming (the content is still one tap away). *(Low)*
- **Export to Markdown drops thinking + file/apk widgets.** `exportMarkdown()` only
  walks `.msg`/`.tool-card`/`.approval`/`.compact-divider`. Including collapsed
  thinking and produced-artifact links would make exports complete. *(Low)*

## Artifacts / widgets

- **`list_apks` command is dead code from the UI.** The broker handles `LIST_APKS`
  but nothing in `web-ui/` sends it. Either wire an "Artifacts" drawer that lists
  every built `.apk/.aab` on demand, or drop the command. *(Low)*

## Dev/test notes

- Live UI testing runs against the **mock engine** (`npm run dev`), which costs no
  model tokens — exercise it freely. The "use sonnet / low effort" cost guidance
  only applies when driving the **real** `claude` engine (needs creds, not present
  on this box).

<!-- More items appended as live testing surfaces them. -->
