/**
 * The three numbers behind "hold the block at the edge and the calendar pages".
 *
 * They are here rather than in a browser because they are the only part of the gesture
 * that is a JUDGEMENT: the zone has to be reachable without being in the way of the
 * weekend columns it overlaps, and the dwell has to be long enough that passing through
 * never fires it.
 */

import { describe, expect, it } from 'vitest';
import {
  EDGE_FIRST_DELAY_MS,
  EDGE_REPEAT_DELAYS_MS,
  EDGE_ZONE_PX,
  edgeDelayFor,
  edgeSideAt,
} from './edgePaging';

/**
 * The grid frame on the shop's window (1646 px wide, the screen padding taken off), with
 * the strips the grid measures: the whole 58 px time-axis gutter on the left, the bare
 * minimum on the right, where every pixel belongs to Sunday.
 */
const AXIS_WIDTH = 58;
const FRAME = { left: 24, right: 1622, leftZone: AXIS_WIDTH, rightZone: EDGE_ZONE_PX };

describe('edgeSideAt', () => {
  it('is null across the whole middle of the grid', () => {
    expect(edgeSideAt(800, FRAME)).toBeNull();
    expect(edgeSideAt(FRAME.left + AXIS_WIDTH + 1, FRAME)).toBeNull();
    expect(edgeSideAt(FRAME.right - EDGE_ZONE_PX - 1, FRAME)).toBeNull();
  });

  it('names the side inside either strip', () => {
    expect(edgeSideAt(FRAME.left + 1, FRAME)).toBe('previous');
    expect(edgeSideAt(FRAME.right - 1, FRAME)).toBe('next');
  });

  it('keeps the zone past the frame, so dragging off the side means the same thing', () => {
    expect(edgeSideAt(FRAME.left - 200, FRAME)).toBe('previous');
    expect(edgeSideAt(FRAME.right + 200, FRAME)).toBe('next');
  });

  it('has no zone at all in a frame too narrow to hold both and a middle', () => {
    expect(
      edgeSideAt(40, { left: 0, right: 80, leftZone: EDGE_ZONE_PX, rightZone: EDGE_ZONE_PX }),
    ).toBeNull();
  });

  /**
   * THE LEFT STRIP STOPS WHERE MONDAY STARTS. It is the whole gutter — a narrower one
   * leaves the hour labels half-covered — and not one pixel more, because everything past
   * it is a day the owner may be aiming at.
   */
  it('ends exactly at the first day column', () => {
    expect(edgeSideAt(FRAME.left + AXIS_WIDTH - 1, FRAME)).toBe('previous');
    expect(edgeSideAt(FRAME.left + AXIS_WIDTH, FRAME)).toBeNull();
  });
});

describe('edgeDelayFor', () => {
  it('waits half a second for the first turn', () => {
    expect(edgeDelayFor(0)).toBe(EDGE_FIRST_DELAY_MS);
    expect(EDGE_FIRST_DELAY_MS).toBe(500);
  });

  it('accelerates, then holds at a floor a week can still be read at', () => {
    const delays = [1, 2, 3, 4, 10].map(edgeDelayFor);
    expect(delays).toEqual([320, 240, 200, 200, 200]);
    // Never faster than the floor, and never slower than the first wait.
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(EDGE_REPEAT_DELAYS_MS[EDGE_REPEAT_DELAYS_MS.length - 1]);
      expect(delay).toBeLessThanOrEqual(EDGE_FIRST_DELAY_MS);
    }
  });

  it('is monotonic: a longer hold never waits longer than the turn before it', () => {
    for (let turns = 1; turns < 8; turns += 1) {
      expect(edgeDelayFor(turns)).toBeLessThanOrEqual(edgeDelayFor(turns - 1));
    }
  });
});
