/**
 * Where a popover lands. `PaintChooser` clamps the same way against `window.innerWidth` and
 * `innerHeight`, but from ESTIMATED dimensions measured by hand; here the grid is always six rows,
 * so the box is a known size and the clipping is arithmetic with a test.
 */

import { describe, expect, it } from 'vitest';
import { popoverPosition, type PopoverAnchor } from './popoverBox';

/** A six-row month grid: the only box this positions. */
const BOX = { width: 268, height: 320 };
const VIEWPORT = { width: 1280, height: 800 };
const GAP = 6;

/** A trigger in the side panel, which sits at the right of the screen. */
const TRIGGER: PopoverAnchor = { top: 180, left: 940, bottom: 208, right: 1240 };

describe('popoverPosition', () => {
  it('opens below the trigger when the box fits there', () => {
    expect(popoverPosition(TRIGGER, BOX, VIEWPORT, GAP)).toEqual({ top: 214, left: 940 });
  });

  it('opens above the trigger when it does not', () => {
    const low: PopoverAnchor = { top: 520, left: 940, bottom: 548, right: 1240 };
    expect(popoverPosition(low, BOX, VIEWPORT, GAP)).toEqual({ top: 194, left: 940 });
  });

  it('clamps to the right edge rather than hanging off it', () => {
    const nearEdge: PopoverAnchor = { top: 180, left: 1120, bottom: 208, right: 1272 };
    expect(popoverPosition(nearEdge, BOX, VIEWPORT, GAP).left).toBe(1012);
  });

  it('clamps to the left edge, for a trigger already partly off it', () => {
    const offLeft: PopoverAnchor = { top: 180, left: -40, bottom: 208, right: 220 };
    expect(popoverPosition(offLeft, BOX, VIEWPORT, GAP).left).toBe(0);
  });

  it('pins the box to the top left when the viewport is smaller than it is', () => {
    const small: PopoverAnchor = { top: 100, left: 60, bottom: 128, right: 180 };
    expect(popoverPosition(small, BOX, { width: 200, height: 240 }, GAP)).toEqual({
      top: 0,
      left: 0,
    });
  });

  it('sits flush against the trigger with a gap of zero', () => {
    expect(popoverPosition(TRIGGER, BOX, VIEWPORT, 0).top).toBe(208);
    const low: PopoverAnchor = { top: 520, left: 940, bottom: 548, right: 1240 };
    expect(popoverPosition(low, BOX, VIEWPORT, 0).top).toBe(200);
  });
});
