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
  EDGE_REPEAT_DELAY_MS,
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
  it('waits half a second for the first turn — the one the owner said felt right', () => {
    expect(edgeDelayFor(0)).toBe(EDGE_FIRST_DELAY_MS);
    expect(EDGE_FIRST_DELAY_MS).toBe(500);
  });

  /**
   * THE REPEAT NEVER SHORTENS. This is the whole of the owner's «si mantengo el ratón ahí
   * empieza a ir como loco semana a semana»: a hold that speeds up has no brakes, and the
   * week they meant to stop on goes past before the hand can leave the strip.
   */
  it('repeats at one constant pace, however long the hold', () => {
    const delays = [1, 2, 3, 4, 10, 60].map(edgeDelayFor);
    expect(delays).toEqual(delays.map(() => EDGE_REPEAT_DELAY_MS));
    expect(EDGE_REPEAT_DELAY_MS).toBe(800);
  });

  /**
   * The two numbers, stated as what they have to be rather than as what they are: fast
   * enough that the calendar is not stuck to the pointer, slow enough that a week can be
   * read on the rail and stopped on.
   */
  it('keeps the pace inside the window a week can be read and stopped in', () => {
    expect(EDGE_REPEAT_DELAY_MS).toBeGreaterThanOrEqual(600);
    expect(EDGE_REPEAT_DELAY_MS).toBeLessThanOrEqual(1000);
  });

  /**
   * The regression in the units the owner reported it in. Their 2.5 s at the edge used to
   * travel nine weeks (500 + 320 + 240 + 200 × 6); three is "one or two weeks ahead" with
   * room to overshoot, and it is what this file now promises.
   */
  it('travels three weeks in the two and a half seconds that used to travel nine', () => {
    let elapsed = 0;
    let turns = 0;
    while (elapsed + edgeDelayFor(turns) <= 2500) {
      elapsed += edgeDelayFor(turns);
      turns += 1;
    }
    expect(turns).toBe(3);
  });
});
