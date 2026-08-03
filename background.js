importScripts('cache.js');

// PR Buddy — background service worker.
//
// Responsibilities:
// 1. Tab dedupe: when a new tab is opened to a PR that already has a tab,
//    close the new tab, focus the existing one, and navigate/reload it so
//    the exact anchor (comment, review thread) is shown with fresh content.
// 2. Update polling: periodically fetch each open PR from the GitHub API,
//    diff comment/review/commit counts against what the user last saw, and
//    surface the result via the action badge and popup.

const TRACKED_URL_PATTERNS = [
  'https://github.com/*/*/pull/*',
  'https://github.com/*/*/commit/*',
];

const DEFAULT_SETTINGS = {
  dedupe: true,
  autoExpand: true,
  pollMinutes: 5,
  token: '',
};

// ---------------------------------------------------------------------------
// Helpers

function parseTrackedUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== 'github.com') return null;
    let m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/);
    if (m) {
      return {
        kind: 'pull',
        owner: m[1],
        repo: m[2],
        number: Number(m[3]),
        key: `${m[1]}/${m[2]}#${m[3]}`.toLowerCase(),
      };
    }
    m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]{7,40})(?:\/|$)/i);
    if (m) {
      return {
        kind: 'commit',
        owner: m[1],
        repo: m[2],
        sha: m[3],
        key: `${m[1]}/${m[2]}@${m[3].slice(0, 7)}`.toLowerCase(),
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

async function getPrState() {
  const { prState } = await chrome.storage.local.get('prState');
  return prState || {};
}

async function setPrState(prState) {
  await chrome.storage.local.set({ prState });
  await updateBadge(prState);
}

async function queryPrTabs() {
  return chrome.tabs.query({ url: TRACKED_URL_PATTERNS });
}

// Hidden background tabs opened by index-pr. They match the PR's URL but are
// throwaways — never dedupe a user's click into one (it gets destroyed when
// indexing finishes, leaving the user with no tab at all), and never treat
// one as "the PR is already open".
const hiddenIndexTabs = new Set();

async function findPrTab(key, excludeTabId, targetUrl) {
  const tabs = await queryPrTabs();
  const candidates = tabs.filter(
    (t) => t.id !== excludeTabId && !hiddenIndexTabs.has(t.id) && parseTrackedUrl(t.url)?.key === key,
  );
  if (candidates.length <= 1 || !targetUrl) return candidates[0] || null;
  // Prefer the tab already on the link's page (an anchor there is a pure
  // scroll), then the conversation page, then the most recently used tab —
  // e.g. don't navigate a Files tab away when a conversation tab exists.
  let targetPath = null;
  try {
    targetPath = new URL(targetUrl).pathname;
  } catch {
    return candidates[0];
  }
  const score = (t) => {
    try {
      const p = new URL(t.url).pathname;
      if (p === targetPath) return 3;
      if (/^\/[^/]+\/[^/]+\/pull\/\d+$/.test(p)) return 2;
    } catch {
      // Unparseable tab URL: lowest score.
    }
    return 1;
  };
  return candidates.sort(
    (a, b) => score(b) - score(a) || (b.lastAccessed || 0) - (a.lastAccessed || 0),
  )[0];
}

function diffCounts(entry) {
  if (!entry?.seen || !entry?.latest) return null;
  const { seen, latest } = entry;
  const d = {
    comments: Math.max(0, latest.comments - seen.comments),
    reviewComments: Math.max(0, latest.reviewComments - seen.reviewComments),
    commits: Math.max(0, latest.commits - seen.commits),
  };
  d.total = d.comments + d.reviewComments + d.commits;
  // updated_at moves for things the counts miss (edits, labels, force-push).
  d.touched = latest.updatedAt !== seen.updatedAt;
  return d;
}

function hasUpdates(entry) {
  const d = diffCounts(entry);
  return Boolean(d && (d.total > 0 || d.touched));
}

async function updateBadge(prState) {
  const count = Object.values(prState).filter(hasUpdates).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#1f883d' });
  await chrome.action.setBadgeText({ text: count ? String(count) : '' });
}

// ---------------------------------------------------------------------------
// Tab dedupe

// Tabs that were just created and haven't settled on a destination yet.
// A tab stays "fresh" through intermediate redirects (e.g. slack.com -> github.com)
// until it commits a github.com navigation or expires.
const freshTabs = new Map(); // tabId -> createdAt
const FRESH_TTL_MS = 30_000;

function isFresh(tabId) {
  const createdAt = freshTabs.get(tabId);
  if (createdAt === undefined) return false;
  if (Date.now() - createdAt > FRESH_TTL_MS) {
    freshTabs.delete(tabId);
    return false;
  }
  return true;
}

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id === undefined) return;
  freshTabs.set(tab.id, Date.now());
  const url = tab.pendingUrl || tab.url;
  if (url) void maybeRedirect(tab.id, url);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  freshTabs.delete(tabId);
  dedupeExemptTabs.delete(tabId);
  hiddenIndexTabs.delete(tabId);
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  if (!isFresh(details.tabId)) return;
  const isGithub = details.url.startsWith('https://github.com/');
  if (isGithub) freshTabs.delete(details.tabId); // reached its destination
  void maybeRedirect(details.tabId, details.url);
});

// PRs the user deliberately asked to open in their own tab (from the popup).
// Without this the dedupe below would close the new tab the instant it opens.
const intentionalDuplicates = new Map(); // key -> expiry timestamp
const INTENTIONAL_TTL_MS = 15_000;

function markIntentionalDuplicate(key) {
  intentionalDuplicates.set(key, Date.now() + INTENTIONAL_TTL_MS);
}

function consumeIntentionalDuplicate(key) {
  const expiry = intentionalDuplicates.get(key);
  if (expiry === undefined) return false;
  intentionalDuplicates.delete(key);
  return expiry > Date.now();
}

// Tab creation fires BOTH tabs.onCreated and webNavigation.onCommitted, and
// each runs maybeRedirect. The intentional mark is single-use, so the tab it
// blessed must stay exempt for its remaining events — otherwise the second
// event deduped and closed it (hidden index tabs, cmd-click new tabs).
const dedupeExemptTabs = new Set();

async function maybeRedirect(newTabId, url) {
  const pr = parseTrackedUrl(url);
  if (!pr) return;

  const settings = await getSettings();
  if (!settings.dedupe) {
    console.debug('[pr-buddy] dedupe: off in settings — leaving', pr.key, 'alone');
    return;
  }

  if (dedupeExemptTabs.has(newTabId)) return;
  if (consumeIntentionalDuplicate(pr.key)) {
    dedupeExemptTabs.add(newTabId);
    console.debug('[pr-buddy] dedupe: tab', newTabId, 'is a deliberate duplicate of', pr.key);
    return;
  }

  const existing = await findPrTab(pr.key, newTabId, url);
  if (!existing) {
    console.debug('[pr-buddy] dedupe: no existing tab for', pr.key, '— keeping tab', newTabId);
    return;
  }

  // Respect deliberate duplicates: cmd-click from the same PR's own tab.
  try {
    const newTab = await chrome.tabs.get(newTabId);
    if (newTab.openerTabId !== undefined) {
      const opener = await chrome.tabs.get(newTab.openerTabId);
      if (parseTrackedUrl(opener.url)?.key === pr.key) {
        console.debug('[pr-buddy] dedupe: tab', newTabId, 'was opened from the PR itself — keeping it');
        return;
      }
    }
  } catch {
    // Tab already gone; nothing to redirect.
    return;
  }

  freshTabs.delete(newTabId);
  // The existing tab must prove it is alive and focusable BEFORE the
  // newcomer dies. The old order (remove first, focus second) ate the click
  // whenever the match was stale — closed in the meantime, or in a window
  // the browser refuses to focus: the new tab was already gone and nothing
  // visible opened. A brief two-tab flash beats a vanished click.
  try {
    await focusPrTab(existing, url);
  } catch (err) {
    console.warn('[pr-buddy] dedupe: could not focus tab', existing.id, 'for', pr.key,
      '— keeping the new tab', err);
    return;
  }
  console.debug('[pr-buddy] dedupe: closing tab', newTabId, '→ tab', existing.id, 'for', pr.key);
  try {
    await chrome.tabs.remove(newTabId);
  } catch {
    // Already closed by the user/browser; the existing tab is focused.
  }
  // Removing the tab the browser considers current makes some browsers
  // (Arc-style sidebars, anything with its own "previous tab" memory) restore
  // THEIR last-active tab — stomping the focus set above and dumping the user
  // back where they were. Assert the destination again after the removal.
  try {
    await chrome.windows.update(existing.windowId, { focused: true });
    await chrome.tabs.update(existing.id, { active: true });
  } catch {
    // The existing tab vanished in the gap; nothing left to re-assert.
  }
}

// Focus a PR tab and land on targetUrl without reloading if we can avoid it.
// When only the fragment differs, the content script sets the hash and
// scrolls — expanding hidden timeline items if needed — and only reloads
// itself when the anchor genuinely isn't on the page yet (comment newer than
// the loaded content). Falls back to navigate+reload if the content script
// isn't reachable (e.g. tab loaded before the extension was installed).
async function focusPrTab(tab, targetUrl) {
  let samePage = false;
  try {
    const current = new URL(tab.url);
    const target = new URL(targetUrl);
    samePage = current.pathname === target.pathname && current.search === target.search;
  } catch {
    // Fall through with a plain navigation.
  }
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
  if (samePage) {
    if (await sendGotoAnchor(tab.id, targetUrl)) return;
    // No content script in that tab (loaded before the extension was
    // installed/updated): inject it and retry before resorting to a reload.
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      if (await sendGotoAnchor(tab.id, targetUrl)) return;
    } catch {
      // Injection not possible (e.g. error page); hard navigation below.
    }
    await chrome.tabs.update(tab.id, { url: targetUrl });
    await chrome.tabs.reload(tab.id);
  } else {
    await chrome.tabs.update(tab.id, { url: targetUrl });
  }
}

async function sendGotoAnchor(tabId, targetUrl) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'goto-anchor', url: targetUrl });
    return Boolean(res?.ok);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Update polling

async function fetchPr(pr, token) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
      { headers },
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function pollUpdates() {
  const settings = await getSettings();
  const tabs = await queryPrTabs();

  const openPrs = new Map();
  for (const tab of tabs) {
    const pr = parseTrackedUrl(tab.url);
    if (pr && !openPrs.has(pr.key)) openPrs.set(pr.key, pr);
  }

  const prState = await getPrState();

  // Forget PRs whose tabs are all closed.
  for (const key of Object.keys(prState)) {
    if (!openPrs.has(key)) delete prState[key];
  }

  for (const [key, pr] of openPrs) {
    if (pr.kind !== 'pull') continue; // commit tabs are deduped but not polled
    const data = await fetchPr(pr, settings.token);
    if (!data) continue;
    const latest = {
      comments: data.comments ?? 0,
      reviewComments: data.review_comments ?? 0,
      commits: data.commits ?? 0,
      updatedAt: data.updated_at,
    };
    const entry = prState[key] || { pr, seen: latest };
    entry.pr = pr;
    entry.latest = latest;
    entry.title = data.title;
    entry.state = data.merged ? 'merged' : data.state;
    entry.draft = Boolean(data.draft);
    entry.url = data.html_url;
    prState[key] = entry;
  }

  await setPrState(prState);
}

async function markSeen(key) {
  const prState = await getPrState();
  const entry = prState[key];
  if (!entry?.latest) return;
  entry.seen = entry.latest;
  await setPrState(prState);
}

// Viewing a PR tab counts as having seen its current state.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    const pr = parseTrackedUrl(tab.url);
    if (pr) await markSeen(pr.key);
  } catch {
    // Tab vanished between events.
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.active) return;
  const pr = parseTrackedUrl(tab.url);
  if (pr) await markSeen(pr.key);
});

// ---------------------------------------------------------------------------
// Alarms / lifecycle

async function schedulePolling() {
  const settings = await getSettings();
  await chrome.alarms.clear('poll');
  chrome.alarms.create('poll', { periodInMinutes: Math.max(1, settings.pollMinutes) });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'poll') void pollUpdates();
});

// Thread/outline caches written by the content script expire after 3 days;
// the shared expiry rules live in cache.js.
async function pruneCaches() {
  const all = await chrome.storage.local.get(null);
  const expired = PRBuddyCache.expiredCacheKeys(all, Date.now());
  if (expired.length) await chrome.storage.local.remove(expired);
}

chrome.runtime.onInstalled.addListener(() => {
  void schedulePolling();
  void pollUpdates();
  void pruneCaches();
});

chrome.runtime.onStartup.addListener(() => {
  void schedulePolling();
  void pollUpdates();
  void pruneCaches();
});

// ---------------------------------------------------------------------------
// Messages from popup/options

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case 'get-state': {
        const [prState, tabs] = await Promise.all([getPrState(), queryPrTabs()]);
        const openTabs = tabs
          .map((t) => ({ tab: t, pr: parseTrackedUrl(t.url) }))
          .filter((t) => t.pr)
          .map(({ tab, pr }) => ({
            key: pr.key,
            tabId: tab.id,
            windowId: tab.windowId,
            tabTitle: tab.title,
            url: tab.url,
            pr,
          }));
        sendResponse({ prState, openTabs });
        break;
      }
      case 'goto-url': {
        // Jump to a specific comment from the popup. Runs through the same
        // ladder as external links (focusPrTab): focus the tab's WINDOW, ask
        // the content script to expand-and-scroll, inject it if it's missing
        // (tab predates the extension), and only then navigate + reload.
        // The popup used to do a bare tabs.update itself: with no content
        // script, a hash-only URL change doesn't reload, GitHub's native
        // anchor jump can't reach collapsed/paginated comments, and the
        // target silently never came into view.
        try {
          const tab = await chrome.tabs.get(message.tabId);
          await focusPrTab(tab, message.url);
        } catch {
          // Tab closed since the popup rendered: open the URL fresh.
          await chrome.tabs.create({ url: message.url, active: true });
        }
        sendResponse({ ok: true });
        break;
      }
      case 'focus-pr': {
        if (message.newTab && message.url) {
          // Explicit "open in its own tab" — bypass dedupe for this one.
          markIntentionalDuplicate(message.key);
          await chrome.tabs.create({ url: message.url, active: true });
          sendResponse({ ok: true });
          break;
        }
        const tab = await findPrTab(message.key);
        let focused = false;
        if (tab) {
          // Reload when there are unseen updates so the user lands on fresh content.
          try {
            const prState = await getPrState();
            const stale = hasUpdates(prState[message.key]);
            await chrome.windows.update(tab.windowId, { focused: true });
            await chrome.tabs.update(tab.id, { active: true });
            if (stale) await chrome.tabs.reload(tab.id);
            await markSeen(message.key);
            focused = true;
          } catch {
            // The match went stale between lookup and focus (tab closed,
            // window unfocusable) — same contract as the deduper: never eat
            // the click, fall through to a fresh tab below.
          }
        }
        if (!focused && message.url) {
          // No live tab for this PR: open it fresh.
          await chrome.tabs.create({ url: message.url, active: true });
        }
        sendResponse({ ok: true });
        break;
      }
      case 'poll-now': {
        await pollUpdates();
        sendResponse({ ok: true });
        break;
      }
      case 'index-pr': {
        // Index a PR's conversation in a background tab without disturbing
        // the tab the user is on (e.g. Files changed). The temp tab must be
        // marked as an intentional duplicate or the deduper would close it
        // and navigate the user's tab away — the opposite of the point.
        if (!message.key || !message.url) {
          sendResponse({ ok: false });
          break;
        }
        markIntentionalDuplicate(message.key);
        const temp = await chrome.tabs.create({ url: message.url, active: false });
        hiddenIndexTabs.add(temp.id);
        const pollMs = message.pollMs || 2000;
        const deadline = Date.now() + (message.timeoutMs || 120_000);
        let indexed = false;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, pollMs));
          try {
            const outline = await chrome.tabs.sendMessage(temp.id, { type: 'get-outline' });
            if (outline?.ok && !outline.subpage && !outline.indexing) {
              indexed = true;
              break;
            }
          } catch {
            // Content script not up yet — keep waiting.
          }
        }
        try {
          await chrome.tabs.remove(temp.id);
        } catch {
          // Already gone.
        } finally {
          hiddenIndexTabs.delete(temp.id);
        }
        sendResponse({ ok: indexed });
        break;
      }
      case 'settings-changed': {
        await schedulePolling();
        await pollUpdates();
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false });
    }
  })().catch((err) => {
    // A handler that dies mid-way must still answer: the popup awaits this
    // response, and an unhandled rejection here left it hanging forever on
    // e.g. a tab that vanished between lookup and use.
    console.warn('[pr-buddy] message handler failed:', message?.type, err);
    try {
      sendResponse({ ok: false, error: String(err) });
    } catch {
      // Channel already closed; nothing to answer.
    }
  });
  return true; // keep the message channel open for the async response
});
