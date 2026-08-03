'use strict';

// The popup sizing policy (sizing.js): one function decides body width and
// list height for BOTH worlds — the action popup, where the window follows
// the body, and a real window (macOS-fullscreen detached popup, popup.html
// opened as a tab), where the window leads. The category under test: no
// combination of saved size and viewport may produce a dead gutter, a list
// clamped above the fold, or a size that fights the user's drag.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { computeSize, MAX_W, MAX_H, POPUP_MAX } = require('../sizing.js');

// A typical rendered header+filters+footer.
const OVERHEAD = 170;

describe('action popup (window follows body)', () => {
  test('defaults: 460 wide, height clamped under the popup cap', () => {
    const s = computeSize({ savedW: undefined, savedH: undefined, innerW: 0, innerH: 0, overhead: OVERHEAD });
    assert.equal(s.w, 460);
    assert.equal(s.h, Math.min(MAX_H, POPUP_MAX - OVERHEAD));
  });

  test('a saved size is honored as-is', () => {
    const s = computeSize({ savedW: 548, savedH: 400, innerW: 0, innerH: 0, overhead: OVERHEAD });
    assert.deepEqual(s, { w: 548, h: 400 });
  });

  test('stability: feeding back the resulting viewport is a fixed point (no ratchet)', () => {
    // Once the popup is open, innerW equals the body width and innerH equals
    // overhead + list height. Recomputing from that state must not grow.
    const first = computeSize({ savedW: 548, savedH: 540, innerW: 0, innerH: 0, overhead: OVERHEAD });
    const second = computeSize({
      savedW: 548,
      savedH: 540,
      innerW: first.w,
      innerH: first.h + OVERHEAD,
      overhead: OVERHEAD,
    });
    assert.deepEqual(second, first);
  });

  test('a tall header squeezes the list, never below the floor', () => {
    const s = computeSize({ savedW: 460, savedH: 540, innerW: 0, innerH: 0, overhead: 520 });
    assert.equal(s.h, 160, 'floor keeps the list usable under an oversized header');
  });
});

describe('real window (window leads)', () => {
  test('wider window: the body fills it — no dead right gutter', () => {
    const s = computeSize({ savedW: 460, savedH: 540, innerW: 548, innerH: 600, overhead: OVERHEAD });
    assert.equal(s.w, 548);
  });

  test('ultra-wide window: fill caps at MAX_W (the CSS centers beyond)', () => {
    const s = computeSize({ savedW: 460, savedH: 540, innerW: 1600, innerH: 900, overhead: OVERHEAD });
    assert.equal(s.w, MAX_W);
  });

  test('taller window: the list extends to the window, not the popup cap', () => {
    const s = computeSize({ savedW: 460, savedH: 540, innerW: 460, innerH: 900, overhead: OVERHEAD });
    assert.equal(s.h, 900 - OVERHEAD, 'no stub list floating above dead space');
  });

  test('near-equal widths do not thrash: a few px of difference is not a fill', () => {
    const s = computeSize({ savedW: 460, savedH: 540, innerW: 463, innerH: 600, overhead: OVERHEAD });
    assert.equal(s.w, 460);
  });
});

describe('handle drags (fill: false — the window lags the body)', () => {
  test('shrinking wins even while the viewport still reports the old size', () => {
    // Mid-drag the window is still 548 wide; adopting it would make every
    // shrink fight itself back to where it started.
    const s = computeSize({ savedW: 500, savedH: 300, innerW: 548, innerH: 700, overhead: OVERHEAD, fill: false });
    assert.deepEqual(s, { w: 500, h: 300 });
  });

  test('the popup cap still applies during a drag', () => {
    const s = computeSize({ savedW: 500, savedH: 540, innerW: 548, innerH: 700, overhead: 200, fill: false });
    assert.equal(s.h, POPUP_MAX - 200);
  });
});
