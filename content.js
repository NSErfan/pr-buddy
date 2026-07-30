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

  // GitHub's timeline pagination rewrites history state and can WIPE the URL
  // fragment mid-expansion. The hash being navigated to is therefore carried
  // explicitly through the whole flow and never read back from location.hash
  // once a goto starts.
  let pendingHash = location.hash || '';

  function targetForHash(hash) {
    if (!hash) return null;
    try {
      const raw = decodeURIComponent(hash.slice(1));
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

  function hashTarget() {
    return targetForHash(location.hash || pendingHash);
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

  function isVisible(el) {
    return el.offsetParent !== null || el.getBoundingClientRect().height > 0;
  }

  // The element (or, if it stays invisible despite revealing, its nearest
  // visible ancestor — e.g. the thread container) is scrolled to the top.
  // Never apply the header offset to an invisible element: its rect is all
  // zeros and the adjustment would just drag the page toward the top.
  function scrollNow(el) {
    revealAncestors(el);
    let target = el;
    if (!isVisible(target)) {
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (isVisible(p)) {
          target = p;
          break;
        }
      }
    }
    target.scrollIntoView({ block: 'start' });
    if (!isVisible(target)) return;
    const top = target.getBoundingClientRect().top;
    if (top < HEADER_CLEARANCE_PX) window.scrollBy(0, top - HEADER_CLEARANCE_PX);
  }

  // Content above the target keeps loading for a while after we scroll,
  // shifting the layout. Re-anchor a few times unless the user took over.
  async function stabilizeAnchor(hash) {
    for (const delay of [400, 1200, 2500]) {
      await sleep(delay);
      if (userScrolled) return;
      const el = targetForHash(hash);
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      if (Math.abs(top - HEADER_CLEARANCE_PX) > 8) scrollNow(el);
    }
  }

  function scrollToHash(hash = location.hash || pendingHash) {
    const el = targetForHash(hash);
    if (!el) return false;
    // Restore the fragment if pagination wiped it — this also drives
    // GitHub's :target highlight on the comment.
    if (location.hash !== hash) location.hash = hash;
    userScrolled = false;
    scrollNow(el);
    void stabilizeAnchor(hash);
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
    // containing <details>, then restore its state. Only thread content is
    // worth this treatment, in parallel under one shared time budget —
    // a serial pass over a big PR's leftovers can burn minutes.
    const stragglers = frags.filter(
      (f) =>
        f.isConnected &&
        f.closest(
          '[data-deferred-content-url], review-thread-collapsible, .js-resolvable-timeline-thread-container',
        ),
    );
    const budget = Date.now() + 8000;
    await Promise.all(
      stragglers.map(async (f) => {
        const details = f.closest('details');
        if (!details || details.open) return;
        details.open = true;
        while (Date.now() < budget && f.isConnected) await sleep(200);
        details.open = false;
      }),
    );
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
    let lastRemaining = -1;
    let stalls = 0;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const buttons = loadMoreButtons();
      if (!buttons.length) break;
      const remaining = hiddenItemCount();
      // No progress since the last round usually means GitHub rate-limited
      // the pagination endpoint; back off instead of hammering it.
      if (remaining === lastRemaining) {
        stalls++;
        if (stalls > 3) break;
        showHud('GitHub is throttling — retrying…');
        await sleep(3000 * stalls);
      } else {
        stalls = 0;
        showHud(remaining ? `Loading hidden comments… ${remaining} left` : 'Loading hidden comments…');
      }
      lastRemaining = remaining;
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
  // Any unexpected error must surface in the HUD — a silent stall looks
  // like "nothing happened" to the user.
  async function gotoAnchor(url) {
    try {
      await gotoAnchorInner(url);
    } catch (err) {
      console.error('[gh-focus-pr] goto-anchor failed:', err);
      showHud('Focus PR error — see console');
      hideHud(undefined, 4000);
    }
  }

  // After landing while indexing is still running, content keeps loading
  // above the target and shifts it, and GitHub's pagination may wipe the
  // fragment again. Hold the anchor in place until indexing settles —
  // stopping immediately if the user scrolls — then restore the fragment.
  async function holdAnchor(hash) {
    while (inflight) {
      await sleep(700);
      if (userScrolled) return;
      const el = targetForHash(hash);
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      if (Math.abs(top - HEADER_CLEARANCE_PX) > 8) scrollNow(el);
    }
    if (!userScrolled && location.hash !== hash) location.hash = hash;
  }

  async function gotoAnchorInner(url) {
    let hash = '';
    try {
      hash = new URL(url).hash;
    } catch {
      return;
    }
    if (!hash) return; // bare PR link: staying where we are is fine
    pendingHash = hash;
    if (location.hash !== hash) location.hash = hash;
    if (scrollToHash(hash)) {
      void holdAnchor(hash);
      return;
    }
    showHud('Locating comment…');
    // Fast path: the comment may sit in a single collapsed review thread we
    // can load directly (via data-hidden-comment-ids), skipping full indexing.
    if ((await loadThreadContaining(hash)) && scrollToHash(hash)) {
      hideHud('Found ✓', 1200);
      void holdAnchor(hash);
      return;
    }
    // Index the page, but land the moment the target materializes — don't
    // make the user wait for the rest of the indexing to finish.
    const expansion = expandAll();
    let expansionDone = false;
    expansion.catch(() => {}).finally(() => {
      expansionDone = true;
    });
    while (!expansionDone && !targetForHash(hash)) await sleep(300);
    if (scrollToHash(hash)) {
      hideHud('Found ✓', 1200);
      void holdAnchor(hash);
      return;
    }
    await expansion;
    if (scrollToHash(hash)) {
      hideHud('Found ✓', 1200);
      return;
    }
    // The thread may have arrived with the newly expanded timeline items.
    if ((await loadThreadContaining(hash)) && scrollToHash(hash)) {
      hideHud('Found ✓', 1200);
      return;
    }
    // Not in the fully-indexed page: the comment is newer than our copy.
    // Navigate to the FULL url (not location.reload() — pagination may have
    // wiped the fragment, and reloading a hashless URL lands nowhere).
    showHud('New comment — refreshing…');
    location.replace(url);
  }

  // ---- conversation outline (for the popup) -------------------------------

  function commentInfo(el) {
    const t = el.querySelector('relative-time');
    return {
      id: el.id,
      author: el.querySelector('.author')?.textContent?.trim() || '',
      avatar: el.querySelector('img.avatar, img.avatar-user')?.src || '',
      time: t?.getAttribute('datetime') || '',
      snippet: ([...el.querySelectorAll('.comment-body')][0]?.textContent || '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 140),
    };
  }

  function buildOutline() {
    if (!isTrackedPage()) return { ok: false };
    const root = document.querySelector('.js-discussion') || document;
    const items = [];
    const seen = new Set();
    const nodes = root.querySelectorAll(
      '[id^="issuecomment-"], [id^="pullrequestreview-"], review-thread-collapsible, .js-resolvable-timeline-thread-container',
    );
    for (const node of nodes) {
      if (/^issuecomment-\d+$/.test(node.id)) {
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        items.push({ type: 'comment', ...commentInfo(node) });
      } else if (/^pullrequestreview-\d+$/.test(node.id)) {
        // GitHub sometimes renders the same review id twice; keep the first.
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        const head = (node.firstElementChild?.textContent || '').replace(/\s+/g, ' ').slice(0, 200);
        const state = /approved these changes/i.test(head)
          ? 'approved'
          : /requested changes/i.test(head)
            ? 'changes'
            : 'reviewed';
        const bodyEl = [...node.querySelectorAll('.comment-body')].find(
          (b) => !b.closest('review-thread-collapsible, .js-resolvable-timeline-thread-container'),
        );
        const t = node.querySelector('relative-time');
        items.push({
          type: 'review',
          id: node.id,
          state,
          author: node.querySelector('.author')?.textContent?.trim() || '',
          avatar: node.querySelector('img.avatar, img.avatar-user')?.src || '',
          time: t?.getAttribute('datetime') || '',
          snippet: (bodyEl?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 140),
        });
      } else {
        let head = (node.firstElementChild?.textContent || '')
          .replace(/\s+/g, ' ')
          .trim()
          .replace(/^Comment thread\s*/i, '');
        const path = head
          .split(/\s+(Outdated|Show resolved|Hide resolved|Resolved)\b/i)[0]
          .trim()
          .slice(0, 160);
        const hiddenIds = (node.getAttribute('data-hidden-comment-ids') || '')
          .split(/\D+/)
          .filter(Boolean);
        const commentEls = [...node.querySelectorAll('[id^="discussion_r"]')].filter((e) =>
          /^discussion_r\d+$/.test(e.id),
        );
        // GitHub can render the same thread container twice — dedupe whole
        // threads by identity, never individual comments (a global comment
        // dedupe leaves the duplicate thread with an empty, unexpandable
        // comment list).
        const sig = hiddenIds[0] || commentEls[0]?.id;
        if (!sig || seen.has(`thread:${sig}`)) continue;
        seen.add(`thread:${sig}`);
        const comments = commentEls.map(commentInfo);
        // Content not loaded yet (indexing still running): fall back to the
        // hidden-comment count so the popup can still show the thread.
        if (!comments.length && !hiddenIds.length) continue;
        items.push({
          type: 'thread',
          path,
          resolved: node.getAttribute('data-resolved') === 'true',
          outdated: [...node.querySelectorAll('.Label')].some((l) =>
            /outdated/i.test(l.textContent || ''),
          ),
          comments,
          count: comments.length || hiddenIds.length,
          anchor: comments[0]?.id || (hiddenIds[0] ? `discussion_r${hiddenIds[0]}` : ''),
        });
      }
    }
    return {
      ok: true,
      indexing: Boolean(inflight),
      title:
        document.querySelector('bdi.js-issue-title, .js-issue-title')?.textContent?.trim() ||
        document.title.replace(/ · .*$/, ''),
      url: location.origin + location.pathname,
      items,
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'goto-anchor') {
      // Ack immediately: the background must not wait on a long expansion
      // (its message channel would die and it would fall back to a reload).
      sendResponse({ ok: true });
      void gotoAnchor(msg.url);
      return;
    }
    if (msg?.type === 'get-outline') {
      sendResponse(buildOutline());
    }
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
  // When the target exists but is inside a collapsed thread, the browser's
  // native jump silently fails — reveal and scroll it ourselves.
  window.addEventListener('hashchange', () => {
    if (location.hash) pendingHash = location.hash;
    if (hashTarget()) scrollToHash();
    else void expandAndAnchor();
  });
})();
