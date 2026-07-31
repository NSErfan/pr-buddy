'use strict';

// Exercises the background worker's 'focus-pr' handling — the path behind
// clicking a row in the popup's PR list.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function loadBackground({ tabs = [], storage = {} } = {}) {
  const calls = { created: [], activated: [], focusedWindows: [], reloaded: [], removed: [] };
  let nextTabId = 1000;

  const chrome = {
    tabs: {
      query: async (q) => {
        const patterns = [].concat(q.url || []);
        const toRe = (p) =>
          new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
        const res = patterns.map(toRe);
        return tabs.filter((t) => res.some((r) => r.test(t.url)));
      },
      get: async (id) => tabs.find((t) => t.id === id) || Promise.reject(new Error('no tab')),
      update: async (id, props) => {
        calls.activated.push({ id, props });
        return tabs.find((t) => t.id === id);
      },
      create: async (props) => {
        calls.created.push(props);
        const t = { id: nextTabId++, url: props.url, windowId: 1 };
        tabs.push(t);
        return t;
      },
      remove: async (id) => {
        calls.removed.push(id);
        const i = tabs.findIndex((t) => t.id === id);
        if (i >= 0) tabs.splice(i, 1);
      },
      reload: async (id) => calls.reloaded.push(id),
      sendMessage: async () => {
        throw new Error('no content script');
      },
      onCreated: { addListener: (fn) => (calls.onTabCreated = fn) },
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} },
      onActivated: { addListener() {} },
    },
    windows: {
      update: async (id, props) => calls.focusedWindows.push({ id, props }),
    },
    storage: {
      local: {
        get: async (key) => {
          if (key === null) return { ...storage };
          if (typeof key === 'string') return key in storage ? { [key]: storage[key] } : {};
          return {};
        },
        set: async (obj) => Object.assign(storage, obj),
        remove: async (keys) => [].concat(keys).forEach((k) => delete storage[k]),
      },
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    alarms: { create() {}, clear: async () => {}, onAlarm: { addListener() {} } },
    webNavigation: { onCommitted: { addListener: (fn) => (calls.onNavCommitted = fn) } },
    scripting: { executeScript: async () => {} },
    runtime: {
      onMessage: { addListener: (fn) => (calls.onMessage = fn) },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
    },
  };

  // URL is a host API, not a JS built-in: without it parseTrackedUrl's
  // try/catch swallows a ReferenceError and every tab looks unparseable.
  const sandbox = {
    chrome, console, URL, URLSearchParams,
    fetch: async () => ({ ok: false }), setTimeout, clearTimeout,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.importScripts = (f) => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx);
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), ctx);
  return { calls, tabs, storage, sandbox };
}

// vm-context objects have a foreign prototype, so compare structurally.
const plain = (v) => JSON.parse(JSON.stringify(v));

function sendFocus(bg, message) {
  return new Promise((resolve) => {
    bg.calls.onMessage(message, {}, resolve);
  });
}

// Chrome fires BOTH tabs.onCreated and webNavigation.onCommitted for a new
// tab; any dedupe test must fire both or it misses double-processing bugs.
async function simulateTabBirth(bg, tab) {
  bg.calls.onTabCreated({ id: tab.id, pendingUrl: tab.url, windowId: tab.windowId ?? 1 });
  await new Promise((r) => setTimeout(r, 5));
  bg.calls.onNavCommitted({ tabId: tab.id, frameId: 0, url: tab.url });
  await new Promise((r) => setTimeout(r, 20));
}

const PR_A = 'https://github.com/acme/app/pull/1';
const PR_B = 'https://github.com/acme/app/pull/2';

describe('focus-pr (clicking a row in the PR list)', () => {
  test('focuses the existing tab, and its window, when the PR is open', async () => {
    const bg = loadBackground({
      tabs: [
        { id: 1, url: PR_A, windowId: 10 },
        { id: 2, url: PR_B, windowId: 11 },
      ],
    });
    await sendFocus(bg, { type: 'focus-pr', key: 'acme/app#2', url: PR_B });
    assert.deepEqual(plain(bg.calls.activated), [{ id: 2, props: { active: true } }]);
    assert.deepEqual(plain(bg.calls.focusedWindows), [{ id: 11, props: { focused: true } }]);
    assert.equal(bg.calls.created.length, 0, 'must not open a duplicate tab');
  });

  test('opens a new tab when the PR has no tab open', async () => {
    const bg = loadBackground({ tabs: [{ id: 1, url: PR_A, windowId: 10 }] });
    await sendFocus(bg, { type: 'focus-pr', key: 'acme/app#2', url: PR_B });
    assert.deepEqual(plain(bg.calls.created), [{ url: PR_B, active: true }]);
  });

  test('opens a new tab when asked to, even if the PR is already open', async () => {
    const bg = loadBackground({ tabs: [{ id: 2, url: PR_B, windowId: 11 }] });
    await sendFocus(bg, { type: 'focus-pr', key: 'acme/app#2', url: PR_B, newTab: true });
    assert.deepEqual(plain(bg.calls.created), [{ url: PR_B, active: true }]);
    assert.equal(bg.calls.activated.length, 0, 'must not steal focus to the old tab');
  });

  test('is a no-op rather than a crash when there is no tab and no url', async () => {
    const bg = loadBackground({ tabs: [] });
    const res = await sendFocus(bg, { type: 'focus-pr', key: 'acme/app#9' });
    assert.deepEqual(plain(res), { ok: true });
    assert.equal(bg.calls.created.length, 0);
  });
});

describe('deliberate duplicates survive dedupe', () => {
  const tick = () => new Promise((r) => setTimeout(r, 20));

  test('a tab opened via "new tab" is not closed by the deduper', async () => {
    const bg = loadBackground({ tabs: [{ id: 2, url: PR_B, windowId: 11 }] });
    await sendFocus(bg, { type: 'focus-pr', key: 'acme/app#2', url: PR_B, newTab: true });
    const created = bg.tabs.find((t) => t.id >= 1000);
    await simulateTabBirth(bg, { id: created.id, url: PR_B });
    assert.deepEqual(plain(bg.calls.removed), [], 'the intentional duplicate must survive BOTH events');
  });

  test('an ordinary duplicate (e.g. a Slack link) is still deduped', async () => {
    const bg = loadBackground({ tabs: [{ id: 2, url: PR_B, windowId: 11 }] });
    const extra = await bg.sandbox.chrome.tabs.create({ url: PR_B, active: true });
    await simulateTabBirth(bg, { id: extra.id, url: PR_B });
    assert.deepEqual(plain(bg.calls.removed), [extra.id], 'dedupe must still close it');
  });

  test('the bypass is single-use: a later duplicate is deduped again', async () => {
    const bg = loadBackground({ tabs: [{ id: 2, url: PR_B, windowId: 11 }] });
    await sendFocus(bg, { type: 'focus-pr', key: 'acme/app#2', url: PR_B, newTab: true });
    const first = bg.tabs.find((t) => t.id >= 1000);
    await simulateTabBirth(bg, { id: first.id, url: PR_B });
    const second = await bg.sandbox.chrome.tabs.create({ url: PR_B, active: true });
    await simulateTabBirth(bg, { id: second.id, url: PR_B });
    assert.deepEqual(plain(bg.calls.removed), [second.id]);
  });
});

describe('index-pr (background indexing for the Files tab)', () => {
  test('opens an inactive tab, waits for indexing, closes it, reports ok', async () => {
    const bg = loadBackground({ tabs: [] });
    let polls = 0;
    bg.sandbox.chrome.tabs.sendMessage = async () => {
      polls++;
      if (polls < 3) throw new Error('not ready');
      return { ok: true, subpage: false, indexing: false };
    };
    const res = await sendFocus(bg, {
      type: 'index-pr', key: 'acme/app#2', url: PR_B, pollMs: 10, timeoutMs: 2000,
    });
    assert.equal(plain(res).ok, true);
    assert.deepEqual(plain(bg.calls.created), [{ url: PR_B, active: false }]);
    assert.equal(bg.calls.removed.length, 1, 'temp tab must be closed');
    assert.ok(polls >= 3);
  });

  test('the temp tab survives the deduper (intentional duplicate)', async () => {
    const bg = loadBackground({ tabs: [{ id: 2, url: PR_B, windowId: 11 }] });
    bg.sandbox.chrome.tabs.sendMessage = async () => ({ ok: true, subpage: false, indexing: false });
    const done = sendFocus(bg, {
      type: 'index-pr', key: 'acme/app#2', url: PR_B, pollMs: 10, timeoutMs: 2000,
    });
    await new Promise((r) => setTimeout(r, 5));
    const temp = bg.tabs.find((t) => t.id >= 1000);
    await simulateTabBirth(bg, { id: temp.id, url: PR_B });
    await done;
    // removed exactly once — by index-pr's cleanup, not by the deduper
    assert.equal(bg.calls.removed.length, 1);
    assert.ok(bg.tabs.every((t) => t.id !== temp.id), 'cleanup removed the temp tab');
  });

  test('reports failure when indexing never completes', async () => {
    const bg = loadBackground({ tabs: [] });
    bg.sandbox.chrome.tabs.sendMessage = async () => { throw new Error('never ready'); };
    const res = await sendFocus(bg, {
      type: 'index-pr', key: 'acme/app#2', url: PR_B, pollMs: 10, timeoutMs: 100,
    });
    assert.equal(plain(res).ok, false);
    assert.equal(bg.calls.removed.length, 1, 'temp tab still cleaned up');
  });
});

describe('goto-url (jumping to a comment from the popup)', () => {
  const ANCHOR = `${PR_A}#discussion_r42`;

  test('same page with a content script: focus window+tab, hand off the anchor, no reload', async () => {
    const bg = loadBackground({ tabs: [{ id: 5, url: PR_A, windowId: 12 }] });
    const gotos = [];
    bg.sandbox.chrome.tabs.sendMessage = async (id, msg) => {
      gotos.push({ id, msg });
      return { ok: true };
    };
    await sendFocus(bg, { type: 'goto-url', tabId: 5, url: ANCHOR });
    assert.deepEqual(plain(bg.calls.focusedWindows), [{ id: 12, props: { focused: true } }]);
    assert.deepEqual(plain(bg.calls.activated), [{ id: 5, props: { active: true } }]);
    assert.deepEqual(plain(gotos), [{ id: 5, msg: { type: 'goto-anchor', url: ANCHOR } }]);
    assert.equal(bg.calls.reloaded.length, 0, 'no reload when the content script took it');
  });

  test('same page, no content script even after injection: navigate + reload (the old popup path silently did neither)', async () => {
    const bg = loadBackground({ tabs: [{ id: 5, url: PR_A, windowId: 12 }] });
    // default sendMessage throws — a tab from before the extension existed
    await sendFocus(bg, { type: 'goto-url', tabId: 5, url: ANCHOR });
    const urlUpdates = plain(bg.calls.activated).filter((c) => c.props.url);
    assert.deepEqual(urlUpdates, [{ id: 5, props: { url: ANCHOR } }]);
    assert.deepEqual(plain(bg.calls.reloaded), [5], 'hash-only updates never reload on their own');
  });

  test('tab on a different page: plain navigation carries the anchor', async () => {
    const bg = loadBackground({ tabs: [{ id: 5, url: `${PR_A}/files`, windowId: 12 }] });
    await sendFocus(bg, { type: 'goto-url', tabId: 5, url: ANCHOR });
    const urlUpdates = plain(bg.calls.activated).filter((c) => c.props.url);
    assert.deepEqual(urlUpdates, [{ id: 5, props: { url: ANCHOR } }]);
    assert.equal(bg.calls.reloaded.length, 0);
  });

  test('tab closed since the popup rendered: open the URL in a fresh tab', async () => {
    const bg = loadBackground({ tabs: [] });
    await sendFocus(bg, { type: 'goto-url', tabId: 99, url: ANCHOR });
    assert.deepEqual(plain(bg.calls.created), [{ url: ANCHOR, active: true }]);
  });
});
