<img src="icons/icon-128.png" width="72" alt="">

# PR Buddy

A Chrome extension that keeps each GitHub pull request in **one tab** — and
gives you the whole review conversation in a popup you can search, filter, and
jump around from.

## The problem

You're reviewing a PR. Replies arrive as notifications in Slack, email, and
GitHub itself. Every link you click opens *another* tab of the same PR — one
per comment thread — until you have a dozen near-identical tabs and no idea
which one is current. Worse, GitHub collapses long timelines into "N hidden
items", so half those links land on an anchor that doesn't exist yet and the
page just scrolls somewhere arbitrary.

PR Buddy fixes both halves of that.

## What it does

### One tab per PR

When a link opens a new tab for a PR you already have open, PR Buddy closes the
new tab, focuses the existing one, and navigates it to the exact anchor from the
link (`#discussion_r…`, `#issuecomment-…`).

If that comment is already loaded in the page, it **scrolls** to it — no reload,
no losing your place. Only when the comment genuinely isn't there does it
navigate. Deliberate duplicates are respected: Cmd/Ctrl-clicking from within the
PR's own tab (to put the diff side by side, say) is left alone.

### Nothing stays hidden

A content script expands GitHub's collapsed timeline — "Load more…", deferred
review threads, lazy `<include-fragment>`s — so every comment anchor exists
before anything tries to scroll to it. Expanded content is cached for three
days, keyed on the timeline's structure, so a reload doesn't start from zero.

### The conversation, in a popup

The popup lists every thread and comment in the PR as a card: file path, author
avatars, resolved/outdated state, and a preview that expands in place.

- **Filter** by All / Needs reply / Resolved / Outdated / Comments, with live counts.
- **Search** files, comments, and people. Every whitespace-separated term must
  match, so `steven cancel` finds threads where Steven discussed cancellation.
  Matches are highlighted and a thread's preview switches to the comment that
  matched. Search collapses into the filter row, costing no vertical space.
- **People filter** — an avatar stack of everyone who spoke, most-involved
  first. Tap faces to see only their threads; multi-select is a union.
- **Sort** by timeline order or most recent activity.
- **Resize** the popup by dragging its corner.
- Your expanded cards, scroll position, selection, search, and people filter are
  all remembered per PR, so reopening the popup puts you back where you were.

Clicking a card jumps the page to that comment.

### Works on the Files changed tab

GitHub's `/changes` view is a React app with none of the conversation DOM, so it
can't be indexed directly. The popup serves the PR's cached conversation index
there instead — search, filters, and people all work — and clicking a comment
flips the tab to the Conversation view landed on that comment. If the PR was
never indexed, the popup offers **Index in background**: it loads the
conversation in a hidden tab, indexes it, closes it, and fills the popup in
place, so you never leave the diff.

### Update tracking

Every few minutes PR Buddy asks the GitHub API about each PR you have a tab
open for. If comments, review comments, or commits arrived since you last
looked, the toolbar badge shows how many PRs have news and the popup says what
changed ("+2 comments, +1 commit"). Looking at a PR tab marks it as seen.

## Install

Not on the Chrome Web Store — load it unpacked:

1. Clone this repo
2. Open `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the repo folder

There is no build step. The extension is plain JavaScript; `npm install` is only
needed to run the tests.

## Keyboard

| Key | Does |
| --- | --- |
| `J` / `K` | Move between cards |
| `↵` | Expand or collapse the selected card |
| `G` | Jump the page to the selected comment |
| `/` | Open search |
| `Esc` | Close search |

## Settings

Popup → **Settings**:

- **Reuse existing PR tabs** — toggle the dedupe behavior.
- **Auto-expand hidden timeline items** — toggle the "Load more…" auto-clicking.
- **Poll interval** — how often to check the API (default 5 min).
- **Personal access token** — optional, but required for private repositories
  and a higher rate limit (5,000/hr instead of 60/hr). A fine-grained token with
  read-only *Pull requests* permission is enough. Stored only in local extension
  storage, never sent anywhere but api.github.com.

## How it's put together

| File | Role |
| --- | --- |
| `background.js` | Service worker: tab dedupe, API polling, badge, messaging |
| `content.js` | Runs on github.com: expands the timeline, indexes threads, scrolls to anchors |
| `cache.js` | Shared cache module — content script, worker, popup, and tests all load it |
| `popup.{html,css,js}` | The conversation UI |
| `options.{html,js}` | Settings page |
| `tools/make-icons.py` | Generates `icons/icon-{16,32,48,128}.png` from `icons/glyph-source.png` |

`cache.js` is a UMD-ish module so the same code backs the content script
(`<script>`), the service worker (`importScripts`), the popup, and Node tests —
one implementation of the cache-key and freshness rules, not four.

The 16px icon is drawn separately: at that size the ringed nodes and speech
bubble collapse into a blob, so it uses a simplified branch with filled nodes.

## Development

```bash
npm install
npm test
```

Tests are `node --test` + jsdom. They cover the cache module (keys, freshness,
TTL pruning, the refuse-to-clobber rules) and run the real `background.js`
inside a `node:vm` sandbox with a mocked Chrome API to exercise tab dedupe and
background indexing end to end.

One test is marked `CONTRACT`: it pins the popup's hand-built cache-key string
to the key the saver actually produces. An earlier casing bug made every cached
outline invisible in production while both sides passed their own unit tests —
that test exists so it can't happen twice.

## Limitations

- Without a token, only public repos can be checked, at 60 requests/hour (one
  request per open PR per poll).
- Update detection uses the PR's aggregate counts (`comments`,
  `review_comments`, `commits`) plus `updated_at`, so it can tell you *that*
  something changed and roughly what kind — not which specific thread.
- Dedupe applies to newly created tabs, which is how external apps open links.
  Typing a PR URL into an existing tab's address bar isn't intercepted.
- Search covers the current PR. Cross-PR search isn't implemented.

## License

MIT — see [LICENSE](LICENSE).
