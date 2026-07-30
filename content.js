// GitHub Focus PR — content script for PR and commit pages.
//
// On load it builds a complete "index" of the conversation: expands every
// "N hidden items / Load more…" range and force-loads lazy thread fragments,
// so every comment anchor exists in the DOM (threads stay visually
// collapsed). A status pill shows progress and confirms when indexing is
// done. Incoming links ('goto-anchor' from the background worker) then
// resolve against the indexed page: expand the containing thread, scroll,
// highlight — no reload. Reload happens only for comments genuinely newer
// than the loaded page.

(() => {
  if (window.__ghFocusPrContentLoaded) return; // guard against double injection
  window.__ghFocusPrContentLoaded = true;

  const PAGE_RE = /^\/[^/]+\/[^/]+\/(?:pull\/\d+|commit\/[0-9a-f]+)(?:\/|$)/i;
  const MAX_ROUNDS = 60; // safety cap on "Load more" clicks
  const LOAD_TIMEOUT_MS = 10_000;
  const HEADER_CLEARANCE_PX = 72; // keep the target below GitHub's sticky header

  function isTrackedPage() {
    return PAGE_RE.test(location.pathname);
  }

  async function autoExpandEnabled() {
    try {
      const { settings } = await chrome.storage.local.get('settings');
      return settings?.autoExpand ?? true;
    } catch {
      return true;
    }
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ---- status pill --------------------------------------------------------

  let hud = null;
  let hudHideTimer = null;

  function showHud(text) {
    if (!hud) {
      hud = document.createElement('div');
      hud.id = 'gh-focus-pr-hud';
      hud.style.cssText = [
        'position:fixed', 'bottom:16px', 'right:16px', 'z-index:2147483647',
        'padding:8px 14px', 'border-radius:999px',
        'font:600 12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        'background:#1f883d', 'color:#ffffff',
        'box-shadow:0 4px 12px rgba(0,0,0,0.3)',
        'pointer-events:none', 'transition:opacity 0.3s', 'opacity:0',
      ].join(';');
      document.documentElement.append(hud);
    }
    clearTimeout(hudHideTimer);
    hud.textContent = text;
    requestAnimationFrame(() => {
      if (hud) hud.style.opacity = '1';
    });
  }

  function hideHud(finalText, delayMs = 2000) {
    if (!hud) return;
    if (finalText) hud.textContent = finalText;
    clearTimeout(hudHideTimer);
    hudHideTimer = setTimeout(() => {
      if (hud) hud.style.opacity = '0';
    }, delayMs);
  }

  // ---- user-scroll detection: stop auto re-anchoring once the user moves --

  let userScrolled = false;
  for (const type of ['wheel', 'touchmove', 'mousedown', 'keydown']) {
    addEventListener(type, () => {
      userScrolled = true;
    }, { passive: true, capture: true });
  }

  // ---- anchor handling ----------------------------------------------------

  function hashTarget() {
    if (!location.hash) return null;
    try {
      const raw = decodeURIComponent(location.hash.slice(1));
      const direct = document.getElementById(raw);
      if (direct) return direct;
      // Review-comment anchors vary by page: #discussion_r123 (conversation)
      // vs #r123 (files). Try the sibling form before giving up.
      const num = numericCommentId(raw);
      if (num) {
        return (
          document.getElementById(`discussion_r${num}`) || document.getElementById(`r${num}`)
        );
      }
      return null;
    } catch {
      return null;
    }
  }

  // "discussion_r3680857039" / "r3680857039" -> "3680857039" (else null)
  function numericCommentId(idOrHash) {
    const m = idOrHash.replace(/^#/, '').match(/^(?:discussion_)?r(\d+)$/);
    return m ? m[1] : null;
  }

  // Make the target actually visible before scrolling: open collapsed
  // <details> ancestors and unhide the content wrapper that
  // <review-thread-collapsible> keeps `hidden` while a thread is collapsed
  // (its "Show resolved" toggle doesn't respond to programmatic clicks).
  function revealAncestors(el) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (p.tagName === 'DETAILS' && !p.open) p.open = true;
      if (p.hidden) p.hidden = false;
    }
  }

  function scrollNow(el) {
    revealAncestors(el);
    el.scrollIntoView({ block: 'start' });
    const top = el.getBoundingClientRect().top;
    if (top < HEADER_CLEARANCE_PX) window.scrollBy(0, top - HEADER_CLEARANCE_PX);
  }

  // Content above the target keeps loading for a while after we scroll,
  // shifting the layout. Re-anchor a few times unless the user took over.
  async function stabilizeAnchor() {
    for (const delay of [400, 1200, 2500]) {
      await sleep(delay);
      if (userScrolled) return;
      const el = hashTarget();
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      if (Math.abs(top - HEADER_CLEARANCE_PX) > 8) scrollNow(el);
    }
  }

  function scrollToHash() {
    const el = hashTarget();
    if (!el) return false;
    userScrolled = false;
    scrollNow(el);
    void stabilizeAnchor();
    return true;
  }

  // ---- timeline expansion + fragment preload ------------------------------

  function loadMoreButtons() {
    const buttons = new Set();
    for (const b of document.querySelectorAll('button.ajax-pagination-btn')) buttons.add(b);
    // Fallback in case GitHub renames the class: any button inside a
    // pagination form whose label mentions loading more.
    for (const b of document.querySelectorAll('form.ajax-pagination-form button')) buttons.add(b);
    for (const b of document.querySelectorAll('button')) {
      if (/load more/i.test(b.textContent || '')) buttons.add(b);
    }
    return [...buttons].filter((b) => !b.disabled && b.isConnected && b.offsetParent !== null);
  }

  function hiddenItemCount() {
    let n = 0;
    for (const f of document.querySelectorAll('form.ajax-pagination-form')) {
      const text = f.parentElement?.textContent || f.textContent || '';
      const m = text.match(/(\d[\d,]*)\s+hidden item/);
      if (m) n += parseInt(m[1].replace(/,/g, ''), 10);
    }
    return n;
  }

  function indexedAnchorCount() {
    return document.querySelectorAll(
      '[id^="issuecomment-"], [id^="discussion_r"], [id^="pullrequestreview-"]',
    ).length;
  }

  // Wait until every clicked button is replaced by loaded content (GitHub
  // swaps the pagination form for the new timeline items) or the timeout hits.
  async function waitForDetach(buttons) {
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (buttons.every((b) => !b.isConnected || b.disabled)) return;
      await sleep(250);
    }
  }

  // Resolved/outdated review threads are <review-thread-collapsible> elements
  // whose content is fetched only when expanded: the inner <include-fragment>
  // has NO src — the fetch URL lives on the container as
  // data-deferred-content-url, and data-hidden-comment-ids names the review
  // comment ids hidden inside. Pointing the fragment's src at that URL loads
  // the thread invisibly (it stays visually collapsed).

  function deferredThreadContainers() {
    return [...document.querySelectorAll('[data-deferred-content-url]')].filter((c) =>
      c.querySelector('include-fragment'),
    );
  }

  async function loadDeferredContainer(container) {
    const url = container.getAttribute('data-deferred-content-url');
    const frag = container.querySelector('include-fragment');
    if (!url || !frag) return;
    if (!frag.getAttribute('src')) frag.setAttribute('src', url);
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    while (Date.now() < deadline && frag.isConnected) await sleep(200);
  }

  // Fast path for an incoming link: load ONLY the collapsed thread that
  // contains the target comment, located via data-hidden-comment-ids.
  async function loadThreadContaining(hash) {
    const num = numericCommentId(hash.replace(/^#/, ''));
    if (!num) return false;
    const container = [...document.querySelectorAll('[data-hidden-comment-ids]')].find((c) =>
      (c.getAttribute('data-hidden-comment-ids') || '').split(/\D+/).includes(num),
    );
    if (!container) return false;
    await loadDeferredContainer(container);
    return true;
  }

  async function preloadDeferredThreads(onProgress) {
    const containers = deferredThreadContainers();
    const BATCH = 6;
    for (let i = 0; i < containers.length; i += BATCH) {
      await Promise.all(containers.slice(i, i + BATCH).map(loadDeferredContainer));
      onProgress?.(Math.min(i + BATCH, containers.length), containers.length);
    }
  }

  // Force-load collapsed thread contents without visually opening anything.
  // Lazy include-fragments fetch on visibility; flipping them to eager (and
  // promoting any deferred src) fetches immediately, and each element
  // replaces itself with the thread's comments when done.
  async function preloadLazyFragments() {
    const root = document.querySelector('.js-discussion') || document;
    // Skip fragments that are UI chrome, not conversation content: comment
    // "…" action menus, edit forms, and toolbars are also lazy fragments.
    const frags = [...root.querySelectorAll('include-fragment')].filter((f) => {
      if (f.closest('details-menu, .dropdown-menu, .js-comment-update, markdown-toolbar')) {
        return false;
      }
      const deferredSrc = f.getAttribute('data-deferred-src') || f.getAttribute('data-src');
      return f.getAttribute('loading') === 'lazy' || (!f.getAttribute('src') && deferredSrc);
    });
    if (!frags.length) return;
    for (const f of frags) {
      const deferredSrc = f.getAttribute('data-deferred-src') || f.getAttribute('data-src');
      if (!f.getAttribute('src') && deferredSrc) f.setAttribute('src', deferredSrc);
      f.setAttribute('loading', 'eager');
    }
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (frags.every((f) => !f.isConnected)) return;
      await sleep(250);
    }
    // Stragglers (markup that only loads on open): briefly open the
    // containing <details>, then restore its state.
    for (const f of frags.filter((f) => f.isConnected)) {
      const details = f.closest('details');
      if (!details || details.open) continue;
      details.open = true;
      const d2 = Date.now() + 3000;
      while (Date.now() < d2 && f.isConnected) await sleep(150);
      details.open = false;
    }
  }

  // Single-flight: concurrent callers share the same expansion pass.
  let inflight = null;

  function expandAll() {
    if (!inflight) {
      inflight = runExpansion().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  async function runExpansion() {
    if (!isTrackedPage()) return;
    if (!(await autoExpandEnabled())) return;
    const hadWork = loadMoreButtons().length > 0 || deferredThreadContainers().length > 0;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const buttons = loadMoreButtons();
      if (!buttons.length) break;
      const remaining = hiddenItemCount();
      showHud(remaining ? `Loading hidden comments… ${remaining} left` : 'Loading hidden comments…');
      for (const b of buttons) b.click();
      await waitForDetach(buttons);
      await sleep(150); // let inserted content (and any new buttons) settle
    }
    await preloadDeferredThreads((done, total) => {
      showHud(`Indexing review threads… ${done}/${total}`);
    });
    if (hadWork) showHud('Indexing threads…');
    await preloadLazyFragments();
    if (hadWork) hideHud(`All set — ${indexedAnchorCount()} comments indexed ✓`);
  }

  // ---- link arrival -------------------------------------------------------

  // Full flow for an incoming link: locate, expand if needed, scroll.
  // Reload is the last resort, for comments genuinely newer than the page.
  async function gotoAnchor(url) {
    let hash = '';
    try {
      hash = new URL(url).hash;
    } catch {
      return;
    }
    if (!hash) return; // bare PR link: staying where we are is fine
    if (location.hash !== hash) location.hash = hash;
    if (scrollToHash()) return;
    showHud('Locating comment…');
    // Fast path: the comment may sit in a single collapsed review thread we
    // can load directly (via data-hidden-comment-ids), skipping full indexing.
    if ((await loadThreadContaining(hash)) && scrollToHash()) {
      hideHud('Found ✓', 1200);
      return;
    }
    await expandAll();
    if (scrollToHash()) {
      hideHud('Found ✓', 1200);
      return;
    }
    // The thread may have arrived with the newly expanded timeline items.
    if ((await loadThreadContaining(hash)) && scrollToHash()) {
      hideHud('Found ✓', 1200);
      return;
    }
    // Not in the fully-indexed page: the comment is newer than our copy.
    showHud('New comment — refreshing…');
    location.reload();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'goto-anchor') return;
    // Ack immediately: the background must not wait on a long expansion
    // (its message channel would die and it would fall back to a reload).
    sendResponse({ ok: true });
    void gotoAnchor(msg.url);
  });

  // ---- triggers -----------------------------------------------------------

  async function expandAndAnchor() {
    await expandAll();
    scrollToHash();
  }

  // Full page loads.
  void expandAndAnchor();

  // GitHub's soft navigations (turbo/pjax) don't reinject content scripts.
  document.addEventListener('turbo:load', () => void expandAndAnchor());
  document.addEventListener('pjax:end', () => void expandAndAnchor());

  // Same-page anchor jumps (e.g. the user clicks a timeline link to a
  // still-hidden comment): expand until the target exists, then scroll.
  window.addEventListener('hashchange', () => {
    if (!hashTarget()) void expandAndAnchor();
  });
})();
