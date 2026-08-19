import { describe, expect, it } from 'vitest';
import {
  EDGE_FIRST_DELAY_MS,
  EDGE_REPEAT_DELAY_MS,
  EDGE_ZONE_PX,
  edgeDelayFor,
  edgeSideAt,
} from './edgePaging';

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

  it('repeats at one constant pace, however long the hold', () => {
    const delays = [1, 2, 3, 4, 10, 60].map(edgeDelayFor);
    expect(delays).toEqual(delays.map(() => EDGE_REPEAT_DELAY_MS));
    expect(EDGE_REPEAT_DELAY_MS).toBe(800);
  });

  it('keeps the pace inside the window a week can be read and stopped in', () => {
    expect(EDGE_REPEAT_DELAY_MS).toBeGreaterThanOrEqual(600);
    expect(EDGE_REPEAT_DELAY_MS).toBeLessThanOrEqual(1000);
  });

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
