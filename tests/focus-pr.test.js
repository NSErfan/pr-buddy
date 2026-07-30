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
    webNavigation: { onCommitted: { addListener() {} } },
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
    bg.calls.onTabCreated({ id: created.id, url: PR_B, windowId: 1 });
    await tick();
    assert.deepEqual(plain(bg.calls.removed), [], 'the intentional duplicate must survive');
  });

  test('an ordinary duplicate (e.g. a Slack link) is still deduped', async () => {
    const bg = loadBackground({ tabs: [{ id: 2, url: PR_B, windowId: 11 }] });
    const extra = await bg.sandbox.chrome.tabs.create({ url: PR_B, active: true });
    bg.calls.onTabCreated({ id: extra.id, url: PR_B, windowId: 1 });
    await tick();
    assert.deepEqual(plain(bg.calls.removed), [extra.id], 'dedupe must still close it');
  });

  test('the bypass is single-use: a later duplicate is deduped again', async () => {
    const bg = loadBackground({ tabs: [{ id: 2, url: PR_B, windowId: 11 }] });
    await sendFocus(bg, { type: 'focus-pr', key: 'acme/app#2', url: PR_B, newTab: true });
    const first = bg.tabs.find((t) => t.id >= 1000);
    bg.calls.onTabCreated({ id: first.id, url: PR_B, windowId: 1 });
    await tick();
    const second = await bg.sandbox.chrome.tabs.create({ url: PR_B, active: true });
    bg.calls.onTabCreated({ id: second.id, url: PR_B, windowId: 1 });
    await tick();
    assert.deepEqual(plain(bg.calls.removed), [second.id]);
  });
});
