// PR Buddy — popup sizing decisions.
//
// Shared by the popup (browser global) and the Node test suite
// (module.exports), like cache.js. All viewport/overhead numbers are passed
// in, so the whole "how big should the popup be" policy is unit-testable.
//
// Two worlds must both work:
// - The ACTION POPUP, where the window follows the body: the saved size
//   leads, clamped under Chrome's 600px cap.
// - A REAL WINDOW (the detached popup macOS fullscreen produces, or
//   popup.html opened as a tab), where the window leads: a fixed-size body
//   would leave a dead right gutter and a list clamped above the fold, so
//   the viewport wins whenever it is larger than the requested box.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PRBuddySizing = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const MIN_W = 360, MAX_W = 780, MIN_H = 200, MAX_H = 540;
  // Chrome hard-caps action popups at 600px tall; the header, filters, and
  // footer are fixed costs ("overhead"), so the list absorbs the cap.
  const POPUP_MAX = 590;

  /**
   * The one place that decides body width and list height.
   *
   * fill: false is for handle drags — the window resizes with a lag there,
   * and adopting its stale size would make every shrink fight itself back
   * to where it started.
   */
  function computeSize({ savedW, savedH, innerW = 0, innerH = 0, overhead = 0, fill = true }) {
    let w = savedW || 460;
    // Real window wider than the requested box: fill it, capped at MAX_W
    // (body { margin-inline: auto } centers the column beyond that).
    if (fill && innerW > w + 4) w = Math.min(innerW, MAX_W);
    let h = Math.min(savedH || MAX_H, Math.max(160, POPUP_MAX - overhead));
    // Real window taller than the popup cap: extend the list to the window.
    // In the action popup innerH never exceeds overhead + list height, so
    // this term is a no-op there — the size cannot ratchet upward.
    if (fill) h = Math.max(h, innerH - overhead);
    return { w, h };
  }

  return { MIN_W, MAX_W, MIN_H, MAX_H, POPUP_MAX, computeSize };
});
