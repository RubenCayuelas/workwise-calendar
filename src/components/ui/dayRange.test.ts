/**
 * The range picker's state machine, shaped like `paintSession.ts`: state in, state out, and the
 * caller carries out what came back.
 *
 * Nothing leaves the popover until it has both ends. A half-chosen range reaching the form would
 * fire `previewAbsence` — a real write inside a rolled-back transaction — on every click of a walk
 * through the month, announcing displaced work for a range nobody has finished choosing.
 */

import { describe, expect, it } from 'vitest';
import { MAX_ABSENCE_DAYS } from '../../lib/absences';
import { addDays } from '../../lib/dates';
import { FRI, MON, NEXT_MON, SAT, SUN, THU, WED } from '../../testing/fixtures';
import { rangeCells, rangeClick } from './dayRange';

describe('rangeClick', () => {
  it('holds the first click and commits nothing', () => {
    const result = rangeClick({}, WED);
    expect(result.state).toEqual({ anchor: WED });
    expect(result.committed).toBeUndefined();
  });

  it('commits both ends on the second click', () => {
    expect(rangeClick({ anchor: MON }, FRI).committed).toEqual({ from: MON, to: FRI });
  });

  it('orders the ends however they were clicked', () => {
    expect(rangeClick({ anchor: FRI }, MON).committed).toEqual({ from: MON, to: FRI });
    expect(rangeClick({ anchor: MON }, FRI).committed).toEqual({ from: MON, to: FRI });
  });

  it('is a single day when the second click lands back on the anchor', () => {
    expect(rangeClick({ anchor: WED }, WED).committed).toEqual({ from: WED, to: WED });
  });

  it('lets the anchor go once it has committed, so the next click starts a range', () => {
    const committed = rangeClick({ anchor: MON }, FRI);
    expect(committed.state.anchor).toBeUndefined();

    const again = rangeClick(committed.state, SUN);
    expect(again.state).toEqual({ anchor: SUN });
    expect(again.committed).toBeUndefined();
  });
});

describe('rangeCells', () => {
  it('paints the weekend inside a span as excluded', () => {
    expect(rangeCells(THU, NEXT_MON)).toEqual({
      included: [THU, FRI, NEXT_MON],
      skipped: [SAT, SUN],
    });
  });

  it('paints a span that is nothing but a weekend as written in full', () => {
    expect(rangeCells(SAT, SUN)).toEqual({ included: [SAT, SUN], skipped: [] });
  });

  it('crosses a month boundary without a seam', () => {
    // Monday 31 August to Wednesday 2 September 2026.
    expect(rangeCells('2026-08-31', '2026-09-02')).toEqual({
      included: ['2026-08-31', '2026-09-01', '2026-09-02'],
      skipped: [],
    });
  });

  it('paints the longest span the server accepts, whole', () => {
    const last = addDays(MON, MAX_ABSENCE_DAYS - 1);
    const cells = rangeCells(MON, last);
    expect(cells.included.length + cells.skipped.length).toBe(MAX_ABSENCE_DAYS);
    expect(cells.included[cells.included.length - 1]).toBe(last);
  });

  it('paints no cell past the cap, which is what the server refuses', () => {
    const past = addDays(MON, MAX_ABSENCE_DAYS);
    const cells = rangeCells(MON, past);
    expect(cells.included.length + cells.skipped.length).toBe(MAX_ABSENCE_DAYS);
    expect(cells.included).not.toContain(past);
    expect(cells.skipped).not.toContain(past);
  });

  it('takes a committed span straight from the click, backwards ones included', () => {
    const { committed } = rangeClick({ anchor: NEXT_MON }, THU);
    expect(committed).toEqual({ from: THU, to: NEXT_MON });
    expect(rangeCells(committed!.from, committed!.to).skipped).toEqual([SAT, SUN]);
  });
});
