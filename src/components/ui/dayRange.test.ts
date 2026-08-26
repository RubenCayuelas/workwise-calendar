/**
 * The range picker's state machine, shaped like `paintSession.ts`: state in, state out, and the
 * caller carries out what came back.
 *
 * ONE CLICK IS ONE DAY, and a second click extends it. The common absence is a single day, and
 * asking for two clicks put the cost on the common case to protect the rare one — the owner met it
 * as being made to click the same day twice.
 *
 * There is therefore no half-chosen range to protect against any more: every click leaves a complete
 * span behind, so `previewAbsence` — a real write inside a rolled-back transaction — is never asked
 * about a range nobody has finished choosing.
 */

import { describe, expect, it } from 'vitest';
import { MAX_ABSENCE_DAYS } from '../../lib/absences';
import { addDays } from '../../lib/dates';
import { FRI, MON, NEXT_MON, SAT, SUN, THU, WED } from '../../testing/fixtures';
import { rangeCells, rangeClick, rangeDiscard, rangeNoticeKey, rangePaint } from './dayRange';

describe('rangeClick', () => {
  it('commits that one day on the FIRST click, and keeps it as the anchor', () => {
    const result = rangeClick({}, WED);
    expect(result.committed).toEqual({ from: WED, to: WED });
    expect(result.state).toEqual({ anchor: WED });
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

  it('lets the anchor go once it has extended, so the next click starts over', () => {
    const extended = rangeClick({ anchor: MON }, FRI);
    expect(extended.state.anchor).toBeUndefined();

    const again = rangeClick(extended.state, SUN);
    expect(again.state).toEqual({ anchor: SUN });
    expect(again.committed).toEqual({ from: SUN, to: SUN });
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

describe('rangePaint', () => {
  it('paints the committed span, and the weekend it drops', () => {
    expect(rangePaint({ from: THU, to: NEXT_MON })).toEqual({
      included: [THU, FRI, NEXT_MON],
      skipped: [SAT, SUN],
    });
  });

  it('paints a span that is nothing but a weekend as written whole', () => {
    expect(rangePaint({ from: SAT, to: SUN })).toEqual({ included: [SAT, SUN], skipped: [] });
  });

  it('paints the one day a first click committed, with nothing provisional about it', () => {
    // The old machine painted no span while an end was pending, because the second click decided
    // which way it ran. There is nothing pending now: the first click already answered.
    const first = rangeClick({}, WED);
    expect(rangePaint(first.committed)).toEqual({ included: [WED], skipped: [] });
  });

  it('paints nothing at all in single-day mode, where there is no far end', () => {
    expect(rangePaint(undefined)).toEqual({ included: [], skipped: [] });
  });

  it('paints nothing for a stored pair that runs backwards', () => {
    expect(rangePaint({ from: FRI, to: MON })).toEqual({ included: [], skipped: [] });
  });
});

describe('closing after one click', () => {
  it('drops the anchor, so a reopened popover starts over instead of extending', () => {
    expect(rangeDiscard({ anchor: WED })).toEqual({});
  });

  it('takes nothing back, because the day that click chose is a real answer', () => {
    const first = rangeClick({}, WED);
    expect(rangePaint(first.committed)).toEqual({ included: [WED], skipped: [] });
    expect(rangeDiscard(first.state)).toEqual({});
    expect(rangeCells(WED, WED).included).toEqual([WED]);
  });

  it('answers with the state it was given when nothing is pending, so a close is not a render', () => {
    const state = {};
    expect(rangeDiscard(state)).toBe(state);
  });
});

describe('rangeNoticeKey', () => {
  it('asks for the first day, and then for the last', () => {
    expect(rangeNoticeKey({})).toBe('dayPicker.rangeStart');
    expect(rangeNoticeKey({ anchor: WED })).toBe('dayPicker.rangePending');
  });
});

describe('the cap this calendar does not clamp', () => {
  it("commits a second click past the cap, because the refusal is the server's", () => {
    const past = addDays(MON, MAX_ABSENCE_DAYS);
    expect(rangeClick({ anchor: MON }, past).committed).toEqual({ from: MON, to: past });
  });

  it('paints only the cells `absenceRange` walks, and never the day past the cap', () => {
    const past = addDays(MON, MAX_ABSENCE_DAYS);
    const paint = rangePaint({ from: MON, to: past });

    expect(paint.included.length + paint.skipped.length).toBe(MAX_ABSENCE_DAYS);
    expect(paint.included).not.toContain(past);
    expect(paint.skipped).not.toContain(past);
  });
});
