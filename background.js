// GitHub Focus PR — background service worker.
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

async function findPrTab(key, excludeTabId, targetUrl) {
  const tabs = await queryPrTabs();
  const candidates = tabs.filter(
    (t) => t.id !== excludeTabId && parseTrackedUrl(t.url)?.key === key,
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
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  if (!isFresh(details.tabId)) return;
  const isGithub = details.url.startsWith('https://github.com/');
  if (isGithub) freshTabs.delete(details.tabId); // reached its destination
  void maybeRedirect(details.tabId, details.url);
});

async function maybeRedirect(newTabId, url) {
  const settings = await getSettings();
  if (!settings.dedupe) return;

  const pr = parseTrackedUrl(url);
  if (!pr) return;

  const existing = await findPrTab(pr.key, newTabId, url);
  if (!existing) return;

  // Respect deliberate duplicates: cmd-click from the same PR's own tab.
  try {
    const newTab = await chrome.tabs.get(newTabId);
    if (newTab.openerTabId !== undefined) {
      const opener = await chrome.tabs.get(newTab.openerTabId);
      if (parseTrackedUrl(opener.url)?.key === pr.key) return;
    }
  } catch {
    // Tab already gone; nothing to redirect.
    return;
  }

  freshTabs.delete(newTabId);
  try {
    await chrome.tabs.remove(newTabId);
  } catch {
    // Already closed; still focus the existing tab.
  }
  await focusPrTab(existing, url);
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

chrome.runtime.onInstalled.addListener(() => {
  void schedulePolling();
  void pollUpdates();
});

chrome.runtime.onStartup.addListener(() => {
  void schedulePolling();
  void pollUpdates();
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
      case 'focus-pr': {
        const tab = await findPrTab(message.key);
        if (tab) {
          // Reload when there are unseen updates so the user lands on fresh content.
          const prState = await getPrState();
          const stale = hasUpdates(prState[message.key]);
          await chrome.windows.update(tab.windowId, { focused: true });
          await chrome.tabs.update(tab.id, { active: true });
          if (stale) await chrome.tabs.reload(tab.id);
          await markSeen(message.key);
        }
        sendResponse({ ok: Boolean(tab) });
        break;
      }
      case 'poll-now': {
        await pollUpdates();
        sendResponse({ ok: true });
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
  })();
  return true; // keep the message channel open for the async response
});
