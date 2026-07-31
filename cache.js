// PR Buddy — thread/outline cache.
//
// Shared by the content script, the background worker (importScripts), the
// popup, and the Node test suite (module.exports). All DOM and storage
// access is passed in, so every invariant here is unit-testable:
//
// - A thread container's data-hidden-comment-ids (server-rendered fresh on
//   every page load) is the cache fingerprint: any new reply changes the id
//   list and forces a refetch of that thread.
// - Fragments age from fetchedAt — the moment GitHub actually served them —
//   not from the last visit; anything older than the TTL is refetched even
//   if its fingerprint still matches.
// - A container counts as loaded only when it holds a discussion_r comment
//   element; the presence of include-fragment is NOT a signal, because
//   loaded content contains nested fragments of its own (edit forms, menus).

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PRBuddyCache = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

  function prCacheKey(prefix, pathname) {
    const m = pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/);
    // Lowercase only the repo part — the prefix must keep its case, because
    // consumers (the popup) construct lookup keys as `outlineCache:` + prKey.
    return m ? `${prefix}:` + `${m[1]}/${m[2]}#${m[3]}`.toLowerCase() : null;
  }

  function threadLoaded(container) {
    return !!container.querySelector('[id^="discussion_r"]');
  }

  function threadContainers(doc) {
    return [...doc.querySelectorAll('[data-deferred-content-url]')];
  }

  function deferredThreadContainers(doc) {
    return threadContainers(doc).filter(
      (c) => !threadLoaded(c) && c.querySelector('include-fragment'),
    );
  }

  // Restore cached fragments into unloaded containers. Returns the number
  // restored and the set of URLs served from cache (their fetchedAt must be
  // carried forward on the next save).
  async function restoreCachedThreads(doc, key, deps) {
    const { storage, now = Date.now } = deps;
    const restoredUrls = new Set();
    if (!key) return { restored: 0, restoredUrls };
    let entry;
    try {
      entry = (await storage.get(key))[key];
    } catch {
      return { restored: 0, restoredUrls };
    }
    if (!entry || typeof entry.fragments !== 'object' || entry.fragments === null) {
      return { restored: 0, restoredUrls };
    }
    let restored = 0;
    for (const c of threadContainers(doc)) {
      if (threadLoaded(c)) continue;
      const url = c.getAttribute('data-deferred-content-url');
      const cached = entry.fragments[url];
      if (!cached || typeof cached.html !== 'string') continue;
      const age = now() - (cached.fetchedAt ?? entry.savedAt ?? 0);
      if (age > CACHE_TTL_MS) continue; // too old: let it refetch fresh
      if (cached.ids !== (c.getAttribute('data-hidden-comment-ids') || '')) continue;
      c.innerHTML = cached.html;
      restoredUrls.add(url);
      restored++;
    }
    return { restored, restoredUrls };
  }

  // Capture every loaded container. restoredUrls marks content that came
  // from cache this load — it keeps its original fetchedAt; everything else
  // was served by GitHub just now.
  async function saveThreadCache(doc, key, outlineKey, outline, restoredUrls, deps) {
    const { storage, now = Date.now } = deps;
    if (!key) return false;
    let prev = {};
    try {
      prev = (await storage.get(key))[key]?.fragments || {};
    } catch {
      // No previous cache readable: treat everything as freshly fetched.
    }
    const fragments = {};
    for (const c of threadContainers(doc)) {
      if (!threadLoaded(c)) continue;
      const url = c.getAttribute('data-deferred-content-url');
      if (!url) continue;
      fragments[url] = {
        ids: c.getAttribute('data-hidden-comment-ids') || '',
        html: c.innerHTML,
        fetchedAt: restoredUrls.has(url) ? prev[url]?.fetchedAt ?? now() : now(),
      };
    }
    // An empty capture must never destroy good data: a page with nothing to
    // offer (wrong tab, half-loaded DOM) keeps the previous fragments, and
    // an outline with no items is never written over anything.
    const hasCapture = Object.keys(fragments).length > 0;
    const hasOutline = Boolean(outlineKey && outline && outline.items && outline.items.length);
    if (!hasCapture && !hasOutline) return false;
    try {
      const payload = { [key]: { savedAt: now(), fragments: hasCapture ? fragments : prev } };
      if (hasOutline) payload[outlineKey] = { savedAt: now(), outline };
      await storage.set(payload);
      return true;
    } catch {
      return false; // quota or storage failure: caching is best-effort
    }
  }

  function isFresh(entry, now = Date.now()) {
    return !!entry && now - (entry.savedAt || 0) <= CACHE_TTL_MS;
  }

  // Which storage keys the background worker should prune. Only cache keys —
  // settings, prState, and anything else are never touched.
  function expiredCacheKeys(allItems, now = Date.now()) {
    const CACHE_PREFIXES = [
      'threadCache:', 'outlineCache:',
      // Pre-0.19.2 the prefix itself was lowercased; prune those legacy
      // entries unconditionally — nothing can read them any more.
      'threadcache:', 'outlinecache:',
    ];
    return Object.keys(allItems).filter((k) => {
      if (!CACHE_PREFIXES.some((p) => k.startsWith(p))) return false;
      if (k.startsWith('threadcache:') || k.startsWith('outlinecache:')) return true;
      return now - (allItems[k]?.savedAt || 0) > CACHE_TTL_MS;
    });
  }

  return {
    CACHE_TTL_MS,
    prCacheKey,
    threadLoaded,
    deferredThreadContainers,
    restoreCachedThreads,
    saveThreadCache,
    isFresh,
    expiredCacheKeys,
  };
});
