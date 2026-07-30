'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const Cache = require('../cache.js');

const DAY = 24 * 60 * 60 * 1000;
const TTL = Cache.CACHE_TTL_MS;

// ---- helpers ---------------------------------------------------------------

function makeDoc(bodyHtml) {
  return new JSDOM(`<body>${bodyHtml}</body>`).window.document;
}

// A collapsed (unloaded) thread container: placeholder include-fragment, no comments.
function unloadedThread(url, ids) {
  return (
    `<review-thread-collapsible data-resolved="true" data-deferred-content-url="${url}"` +
    ` data-hidden-comment-ids="${ids}">` +
    `<div class="header">Show resolved</div>` +
    `<div hidden><include-fragment></include-fragment></div>` +
    `</review-thread-collapsible>`
  );
}

// A loaded thread container: real comment elements, and — critically — a
// NESTED include-fragment (edit form), like real GitHub markup.
function loadedThread(url, ids, commentIds, marker = '') {
  const comments = commentIds
    .map((id) => `<div id="discussion_r${id}" class="review-comment">comment ${id} ${marker}</div>`)
    .join('');
  return (
    `<review-thread-collapsible data-resolved="true" data-deferred-content-url="${url}"` +
    ` data-hidden-comment-ids="${ids}">` +
    `<div class="header">Show resolved</div>` +
    `<div hidden>${comments}` +
    `<div class="js-comment-update"><include-fragment loading="lazy"></include-fragment></div>` +
    `</div>` +
    `</review-thread-collapsible>`
  );
}

class MemStorage {
  constructor(data = {}) {
    this.data = data;
    this.failGet = false;
    this.failSet = false;
  }
  async get(key) {
    if (this.failGet) throw new Error('storage get failed');
    if (key === null) return { ...this.data };
    return key in this.data ? { [key]: this.data[key] } : {};
  }
  async set(obj) {
    if (this.failSet) throw new Error('storage set failed');
    Object.assign(this.data, obj);
  }
  async remove(keys) {
    for (const k of [].concat(keys)) delete this.data[k];
  }
}

const at = (t) => () => t;
const plainv = (v) => JSON.parse(JSON.stringify(v));

// A canonical saved entry for restore tests.
function entryWith(fragments, savedAt = 1_000_000) {
  return { savedAt, fragments };
}

const FRAG = (ids, html, fetchedAt) => ({ ids, html, fetchedAt });
const KEY = 'threadCache:owner/repo#1';

// ---- prCacheKey ------------------------------------------------------------

describe('prCacheKey', () => {
  test('derives a lowercased key from a PR path', () => {
    assert.equal(
      Cache.prCacheKey('threadCache', '/BandLab/BandLab-iOS/pull/22279'),
      'threadcache:bandlab/bandlab-ios#22279',
    );
  });

  test('works for PR subpages (files, commits)', () => {
    assert.equal(
      Cache.prCacheKey('outlineCache', '/o/r/pull/5/files'),
      'outlinecache:o/r#5',
    );
  });

  test('returns null for non-PR pages', () => {
    assert.equal(Cache.prCacheKey('threadCache', '/o/r/commit/abc123'), null);
    assert.equal(Cache.prCacheKey('threadCache', '/o/r/issues/5'), null);
    assert.equal(Cache.prCacheKey('threadCache', '/o/r/pull/notanumber'), null);
  });
});

// ---- threadLoaded / deferredThreadContainers -------------------------------

describe('loaded detection', () => {
  test('a container with a discussion_r element is loaded', () => {
    const doc = makeDoc(loadedThread('/t/1', '11', ['11']));
    assert.equal(Cache.threadLoaded(doc.querySelector('[data-deferred-content-url]')), true);
  });

  test('a placeholder container is not loaded', () => {
    const doc = makeDoc(unloadedThread('/t/1', '11'));
    assert.equal(Cache.threadLoaded(doc.querySelector('[data-deferred-content-url]')), false);
  });

  test('REGRESSION: nested include-fragments inside loaded content do not mark it unloaded', () => {
    // The 0.10.0 bug: "has an include-fragment" was used as the unloaded
    // signal, but loaded content contains nested fragments (edit forms).
    const doc = makeDoc(loadedThread('/t/1', '11', ['11']));
    const c = doc.querySelector('[data-deferred-content-url]');
    assert.ok(c.querySelector('include-fragment'), 'fixture must contain a nested fragment');
    assert.equal(Cache.threadLoaded(c), true);
    assert.equal(Cache.deferredThreadContainers(doc).length, 0);
  });

  test('deferredThreadContainers lists only unloaded containers with a placeholder', () => {
    const doc = makeDoc(
      unloadedThread('/t/1', '11') +
        loadedThread('/t/2', '22', ['22']) +
        `<div data-deferred-content-url="/t/3" data-hidden-comment-ids="33"></div>`, // no fragment at all
    );
    const urls = Cache.deferredThreadContainers(doc).map((c) =>
      c.getAttribute('data-deferred-content-url'),
    );
    assert.deepEqual(urls, ['/t/1']);
  });
});

// ---- restoreCachedThreads --------------------------------------------------

describe('restoreCachedThreads', () => {
  test('restores a fragment whose fingerprint matches and is fresh', async () => {
    const doc = makeDoc(unloadedThread('/t/1', '11 12'));
    const storage = new MemStorage({
      [KEY]: entryWith({ '/t/1': FRAG('11 12', '<div id="discussion_r11">cached</div>', 0) }),
    });
    const r = await Cache.restoreCachedThreads(doc, KEY, { storage, now: at(TTL) });
    assert.equal(r.restored, 1);
    assert.deepEqual([...r.restoredUrls], ['/t/1']);
    assert.ok(doc.getElementById('discussion_r11'), 'comment element must exist after restore');
  });

  test('skips a fragment whose fingerprint mismatches (new reply arrived)', async () => {
    const doc = makeDoc(unloadedThread('/t/1', '11 12 13')); // 13 is new
    const storage = new MemStorage({
      [KEY]: entryWith({ '/t/1': FRAG('11 12', '<div id="discussion_r11">cached</div>', 0) }),
    });
    const r = await Cache.restoreCachedThreads(doc, KEY, { storage, now: at(1000) });
    assert.equal(r.restored, 0);
    assert.equal(doc.getElementById('discussion_r11'), null);
    assert.equal(Cache.deferredThreadContainers(doc).length, 1, 'stays refetchable');
  });

  test('skips a fragment older than the TTL even when the fingerprint matches', async () => {
    const doc = makeDoc(unloadedThread('/t/1', '11'));
    const storage = new MemStorage({
      [KEY]: entryWith({ '/t/1': FRAG('11', '<div id="discussion_r11">old</div>', 0) }),
    });
    const r = await Cache.restoreCachedThreads(doc, KEY, { storage, now: at(TTL + 1) });
    assert.equal(r.restored, 0);
  });

  test('a fragment exactly at the TTL boundary is still fresh', async () => {
    const doc = makeDoc(unloadedThread('/t/1', '11'));
    const storage = new MemStorage({
      [KEY]: entryWith({ '/t/1': FRAG('11', '<div id="discussion_r11">edge</div>', 0) }),
    });
    const r = await Cache.restoreCachedThreads(doc, KEY, { storage, now: at(TTL) });
    assert.equal(r.restored, 1);
  });

  test('legacy entries without fetchedAt age from the entry savedAt', async () => {
    const doc = makeDoc(unloadedThread('/t/1', '11'));
    const legacy = { savedAt: 0, fragments: { '/t/1': { ids: '11', html: '<div id="discussion_r11">x</div>' } } };
    const fresh = await Cache.restoreCachedThreads(makeDoc(unloadedThread('/t/1', '11')), KEY, {
      storage: new MemStorage({ [KEY]: legacy }),
      now: at(TTL),
    });
    assert.equal(fresh.restored, 1);
    const stale = await Cache.restoreCachedThreads(doc, KEY, {
      storage: new MemStorage({ [KEY]: legacy }),
      now: at(TTL + 1),
    });
    assert.equal(stale.restored, 0);
  });

  test('never touches an already-loaded container', async () => {
    const doc = makeDoc(loadedThread('/t/1', '11', ['11'], 'LIVE'));
    const storage = new MemStorage({
      [KEY]: entryWith({ '/t/1': FRAG('11', '<div id="discussion_r11">STALE</div>', 500) }),
    });
    const r = await Cache.restoreCachedThreads(doc, KEY, { storage, now: at(1000) });
    assert.equal(r.restored, 0);
    assert.match(doc.getElementById('discussion_r11').textContent, /LIVE/);
  });

  test('no entry, null key, corrupt entry, or storage failure are all quiet no-ops', async () => {
    const mk = () => makeDoc(unloadedThread('/t/1', '11'));
    // no entry
    assert.equal((await Cache.restoreCachedThreads(mk(), KEY, { storage: new MemStorage() })).restored, 0);
    // null key (non-PR page)
    assert.equal((await Cache.restoreCachedThreads(mk(), null, { storage: new MemStorage() })).restored, 0);
    // corrupt shapes
    for (const bad of [{ savedAt: 1 }, { savedAt: 1, fragments: null }, { savedAt: 1, fragments: 'x' },
      { savedAt: 1, fragments: { '/t/1': { ids: '11', html: 42 } } }]) {
      const r = await Cache.restoreCachedThreads(mk(), KEY, { storage: new MemStorage({ [KEY]: bad }), now: at(2) });
      assert.equal(r.restored, 0);
    }
    // storage throws
    const failing = new MemStorage({ [KEY]: entryWith({}) });
    failing.failGet = true;
    assert.equal((await Cache.restoreCachedThreads(mk(), KEY, { storage: failing })).restored, 0);
  });
});

// ---- saveThreadCache -------------------------------------------------------

describe('saveThreadCache', () => {
  test('captures only loaded containers, with ids, html, and a fresh fetchedAt', async () => {
    const doc = makeDoc(loadedThread('/t/1', '11', ['11']) + unloadedThread('/t/2', '22'));
    const storage = new MemStorage();
    const ok = await Cache.saveThreadCache(doc, KEY, null, null, new Set(), { storage, now: at(777) });
    assert.equal(ok, true);
    const entry = storage.data[KEY];
    assert.equal(entry.savedAt, 777);
    assert.deepEqual(Object.keys(entry.fragments), ['/t/1']);
    assert.equal(entry.fragments['/t/1'].ids, '11');
    assert.equal(entry.fragments['/t/1'].fetchedAt, 777);
    assert.match(entry.fragments['/t/1'].html, /discussion_r11/);
  });

  test('REGRESSION: restored fragments keep their original fetchedAt (no sliding expiry)', async () => {
    // The 0.10.0->0.10.1 bug: re-saving refreshed the clock on every visit,
    // so frequent visits could keep stale content alive forever.
    const doc = makeDoc(loadedThread('/t/1', '11', ['11']));
    const storage = new MemStorage({
      [KEY]: entryWith({ '/t/1': FRAG('11', '<old/>', 100) }, 100),
    });
    await Cache.saveThreadCache(doc, KEY, null, null, new Set(['/t/1']), { storage, now: at(2 * DAY) });
    assert.equal(storage.data[KEY].fragments['/t/1'].fetchedAt, 100, 'original fetch time survives');
    assert.equal(storage.data[KEY].savedAt, 2 * DAY, 'entry savedAt still refreshes');
  });

  test('a freshly fetched fragment gets the current time even if a previous entry existed', async () => {
    const doc = makeDoc(loadedThread('/t/1', '11 12', ['11', '12']));
    const storage = new MemStorage({
      [KEY]: entryWith({ '/t/1': FRAG('11', '<old/>', 100) }, 100),
    });
    // Not in restoredUrls: the content was refetched (fingerprint changed).
    await Cache.saveThreadCache(doc, KEY, null, null, new Set(), { storage, now: at(999) });
    assert.equal(storage.data[KEY].fragments['/t/1'].fetchedAt, 999);
  });

  test('a restored url with no previous record falls back to now', async () => {
    const doc = makeDoc(loadedThread('/t/1', '11', ['11']));
    const storage = new MemStorage(); // prev cache vanished (pruned)
    await Cache.saveThreadCache(doc, KEY, null, null, new Set(['/t/1']), { storage, now: at(555) });
    assert.equal(storage.data[KEY].fragments['/t/1'].fetchedAt, 555);
  });

  test('stores the outline alongside when given', async () => {
    const doc = makeDoc(loadedThread('/t/1', '11', ['11']));
    const storage = new MemStorage();
    const outline = { ok: true, items: [1, 2, 3] };
    await Cache.saveThreadCache(doc, KEY, 'outlineCache:owner/repo#1', outline, new Set(), {
      storage, now: at(42),
    });
    assert.deepEqual(storage.data['outlineCache:owner/repo#1'], { savedAt: 42, outline });
  });

  test('null key is a no-op; storage failure returns false without throwing', async () => {
    const doc = makeDoc(loadedThread('/t/1', '11', ['11']));
    assert.equal(await Cache.saveThreadCache(doc, null, null, null, new Set(), { storage: new MemStorage() }), false);
    const failing = new MemStorage();
    failing.failSet = true;
    assert.equal(await Cache.saveThreadCache(doc, KEY, null, null, new Set(), { storage: failing }), false);
    // failing get for prev must not prevent the save
    const failGet = new MemStorage();
    failGet.failGet = true;
    assert.equal(await Cache.saveThreadCache(doc, KEY, null, null, new Set(), { storage: failGet, now: at(1) }), true);
  });
});

describe('empty saves never destroy good data (clobber regression)', () => {
  // Pre-0.18.1, visiting the React /changes tab captured nothing and wrote
  // empty fragments + an empty outline over the PR's good cache.
  test('a capture with no fragments and an empty outline writes nothing', async () => {
    const storage = new MemStorage({
      [KEY]: entryWith({ '/t/1': FRAG('11', '<div id="discussion_r11">good</div>', 100) }, 100),
      'outlineCache:owner/repo#1': { savedAt: 100, outline: { items: [1] } },
    });
    const doc = makeDoc('<div>react app, nothing indexable</div>');
    const ok = await Cache.saveThreadCache(
      doc, KEY, 'outlineCache:owner/repo#1', { items: [] }, new Set(), { storage, now: at(999) },
    );
    assert.equal(ok, false);
    assert.equal(storage.data[KEY].fragments['/t/1'].html, '<div id="discussion_r11">good</div>');
    assert.deepEqual(plainv(storage.data['outlineCache:owner/repo#1'].outline), { items: [1] });
  });

  test('a non-empty outline with no fragment capture carries previous fragments forward', async () => {
    const storage = new MemStorage({
      [KEY]: entryWith({ '/t/1': FRAG('11', '<x/>', 100) }, 100),
    });
    const doc = makeDoc('<div id="discussion_rX">no thread containers here</div>');
    const ok = await Cache.saveThreadCache(
      doc, KEY, 'outlineCache:owner/repo#1', { items: [1, 2] }, new Set(), { storage, now: at(999) },
    );
    assert.equal(ok, true);
    assert.equal(storage.data[KEY].fragments['/t/1'].html, '<x/>', 'previous fragments preserved');
    assert.equal(storage.data['outlineCache:owner/repo#1'].outline.items.length, 2);
  });

  test('an empty outline is not written even when fragments were captured', async () => {
    const storage = new MemStorage({
      'outlineCache:owner/repo#1': { savedAt: 100, outline: { items: [1] } },
    });
    const doc = makeDoc(loadedThread('/t/1', '11', ['11']));
    const ok = await Cache.saveThreadCache(
      doc, KEY, 'outlineCache:owner/repo#1', { items: [] }, new Set(), { storage, now: at(999) },
    );
    assert.equal(ok, true, 'fragments still save');
    assert.deepEqual(plainv(storage.data['outlineCache:owner/repo#1'].outline), { items: [1] });
  });
});

// ---- full lifecycle --------------------------------------------------------

describe('lifecycle', () => {
  test('save -> fresh page restore -> re-save preserves fetchedAt across visits', async () => {
    const storage = new MemStorage();
    // Visit 1 at t=0: thread fetched live, saved.
    const day0 = makeDoc(loadedThread('/t/1', '11', ['11'], 'ORIGINAL'));
    await Cache.saveThreadCache(day0, KEY, null, null, new Set(), { storage, now: at(0) });
    // Visit 2 at t=2d: fresh page, restore hits, re-save carries fetchedAt=0.
    const day2 = makeDoc(unloadedThread('/t/1', '11'));
    const r2 = await Cache.restoreCachedThreads(day2, KEY, { storage, now: at(2 * DAY) });
    assert.equal(r2.restored, 1);
    assert.match(day2.getElementById('discussion_r11').textContent, /ORIGINAL/);
    await Cache.saveThreadCache(day2, KEY, null, null, r2.restoredUrls, { storage, now: at(2 * DAY) });
    assert.equal(storage.data[KEY].fragments['/t/1'].fetchedAt, 0);
    // Visit 3 at t=4d: fragment is 4 days old -> NOT restored despite daily visits.
    const day4 = makeDoc(unloadedThread('/t/1', '11'));
    const r4 = await Cache.restoreCachedThreads(day4, KEY, { storage, now: at(4 * DAY) });
    assert.equal(r4.restored, 0, 'sliding expiry must not keep stale content alive');
  });

  test('a reply to one thread refetches only that thread', async () => {
    const storage = new MemStorage({
      [KEY]: entryWith({
        '/t/1': FRAG('11', '<div id="discussion_r11">a</div>', 1000),
        '/t/2': FRAG('21 22', '<div id="discussion_r21">b</div>', 1000),
      }, 1000),
    });
    // Fresh page: /t/2 got a new reply (id 23 appended by the server).
    const doc = makeDoc(unloadedThread('/t/1', '11') + unloadedThread('/t/2', '21 22 23'));
    const r = await Cache.restoreCachedThreads(doc, KEY, { storage, now: at(2000) });
    assert.equal(r.restored, 1);
    assert.deepEqual([...r.restoredUrls], ['/t/1']);
    assert.deepEqual(
      Cache.deferredThreadContainers(doc).map((c) => c.getAttribute('data-deferred-content-url')),
      ['/t/2'],
    );
  });
});

// ---- expiry / pruning ------------------------------------------------------

describe('expiredCacheKeys / isFresh', () => {
  test('prunes only expired cache keys, never other storage', () => {
    const now = 10 * DAY;
    const all = {
      'threadCache:a/b#1': { savedAt: now - TTL - 1 },
      'threadCache:a/b#2': { savedAt: now - TTL },       // exactly at TTL: keep
      'outlineCache:a/b#1': { savedAt: now - 5 * DAY },
      'outlineCache:a/b#3': { savedAt: now - DAY },
      'threadCache:broken': {},                           // no savedAt: treat as ancient
      settings: { savedAt: 0 },                           // never touched
      prState: { savedAt: 0 },
    };
    assert.deepEqual(Cache.expiredCacheKeys(all, now).sort(), [
      'outlineCache:a/b#1',
      'threadCache:a/b#1',
      'threadCache:broken',
    ]);
  });

  test('isFresh honors the TTL boundary and rejects junk', () => {
    assert.equal(Cache.isFresh({ savedAt: 0 }, TTL), true);
    assert.equal(Cache.isFresh({ savedAt: 0 }, TTL + 1), false);
    assert.equal(Cache.isFresh(null, 0), false);
    assert.equal(Cache.isFresh(undefined, 0), false);
    assert.equal(Cache.isFresh({}, TTL + 1), false);
  });
});
