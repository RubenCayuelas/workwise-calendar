import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  dayShapeFromSettings,
  maxDayCapacityHours,
  workPeriodsOf,
} from '../../lib/settings';
import type { Settings } from '../../types';
import {
  applySettingsPatch,
  autoFillStopMinutes,
  capCapacityHours,
  capacityReductionOf,
  capacitySlackMinutes,
  changedFields,
  draftIssues,
  hasIssues,
  lunchOf,
  maxCapacityHours,
  patchToSave,
  periodsOf,
  shiftMinutesOf,
  timelineOf,
} from './shift';

/** The factory configuration: 08:00-14:00, 15:30-19:30, 10 h capacity, 1 h margins. */
function settings(patch: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

describe('periodsOf', () => {
  it('returns both periods of the default split shift', () => {
    expect(periodsOf(settings())).toEqual([
      { startMinutes: 480, endMinutes: 840 },
      { startMinutes: 930, endMinutes: 1170 },
    ]);
  });

  it('drops the afternoon when it is switched off', () => {
    expect(periodsOf(settings({ period2Enabled: false }))).toHaveLength(1);
  });

  it('drops a period whose time is being retyped instead of throwing', () => {
    // A cleared `<input type="time">` reports "": normal mid-edit, not an exception.
    expect(periodsOf(settings({ period1Start: '' }))).toEqual([
      { startMinutes: 930, endMinutes: 1170 },
    ]);
  });

  it('drops an afternoon that would start before the morning ends', () => {
    expect(periodsOf(settings({ period2Start: '13:00' }))).toHaveLength(1);
  });
});

describe('the shift and its derived numbers', () => {
  it('adds up to 10 h with the afternoon and 6 h without it', () => {
    expect(shiftMinutesOf(settings())).toBe(600);
    expect(maxCapacityHours(settings())).toBe(10);
    expect(maxCapacityHours(settings({ period2Enabled: false }))).toBe(6);
  });

  it('reports the lunch break between the periods, and none without an afternoon', () => {
    expect(lunchOf(settings())).toEqual({ startMinutes: 840, endMinutes: 930 });
    expect(lunchOf(settings({ period2Enabled: false }))).toBeUndefined();
  });

  it('draws from the top margin to the bottom margin', () => {
    // 07:00 to 20:30: the documented shift, margin to margin.
    expect(timelineOf(settings())).toEqual({ startMinutes: 420, endMinutes: 1230 });
  });

  it('clamps the timeline at midnight rather than running off the day', () => {
    expect(timelineOf(settings({ period1Start: '00:30', visualMarginTop: 2 }))?.startMinutes).toBe(0);
  });
});

describe('capacity, the stop line for auto-fill', () => {
  it('caps at the shift when the afternoon is switched off', () => {
    expect(capCapacityHours(10, settings({ period2Enabled: false }))).toBe(6);
  });

  it('leaves the number alone while no period is usable', () => {
    // Zeroing the capacity because a time is half-typed would destroy the owner's input.
    expect(capCapacityHours(10, settings({ period1Start: '', period2Enabled: false }))).toBe(10);
  });

  it('stops at the end of the day when capacity covers the whole shift', () => {
    expect(autoFillStopMinutes(settings())).toBe(1170);
  });

  it('stops inside the afternoon when capacity is below the shift', () => {
    // 8 h: 6 h of morning, then 2 h from 15:30 -> 17:30.
    expect(autoFillStopMinutes(settings({ defaultDayCapacity: 8 }))).toBe(1050);
  });

  it('stops inside the morning when capacity is below it', () => {
    expect(autoFillStopMinutes(settings({ defaultDayCapacity: 4 }))).toBe(720);
  });
});

describe('applySettingsPatch', () => {
  it('never lowers the capacity to fit a shorter shift — that was the trap', () => {
    // The afternoon off leaves 10 h on a 6 h shift; the draft keeps it until save.
    const draft = applySettingsPatch(settings(), { period2Enabled: false });
    expect(draft.defaultDayCapacity).toBe(10);
    expect(maxCapacityHours(draft)).toBe(6);
  });

  it('never lowers it when a period is shortened either', () => {
    const draft = applySettingsPatch(settings({ period2Enabled: false }), { period1End: '12:00' });
    expect(draft.defaultDayCapacity).toBe(10);
  });

  it('applies the capacity the owner types', () => {
    expect(applySettingsPatch(settings(), { defaultDayCapacity: 6 }).defaultDayCapacity).toBe(6);
  });

  it('does not raise it when the shift grows', () => {
    const draft = applySettingsPatch(settings({ defaultDayCapacity: 8 }), { period2End: '20:30' });
    expect(draft.defaultDayCapacity).toBe(8);
  });
});

describe('capacityReductionOf', () => {
  it('says nothing while the capacity fits the draft', () => {
    expect(capacityReductionOf(settings())).toBeUndefined();
    expect(capacityReductionOf(settings({ defaultDayCapacity: 6 }))).toBeUndefined();
  });

  it('names both numbers and the hours a day they cost', () => {
    expect(capacityReductionOf(settings({ period2Enabled: false }))).toEqual({
      fromHours: 10,
      toHours: 6,
      lostHours: 4,
    });
  });

  it('reads the whole shift, not the afternoon toggle alone', () => {
    expect(capacityReductionOf(settings({ period1End: '12:00', period2End: '17:30' }))).toEqual({
      fromHours: 10,
      toHours: 6,
      lostHours: 4,
    });
  });

  it('stays quiet while a period time is unusable, since that draft cannot be saved', () => {
    expect(capacityReductionOf(settings({ period1Start: '', period2Enabled: false }))).toBeUndefined();
  });
});

describe('patchToSave', () => {
  it('sends only what changed while the capacity still fits', () => {
    const saved = settings();
    expect(patchToSave(saved, settings({ gapColor: '#AABBCC' }))).toEqual({ gapColor: '#AABBCC' });
    expect(patchToSave(saved, saved)).toEqual({});
  });

  // The lowered capacity exists in exactly one place — this patch — so a cancelled
  // confirmation cannot send it.
  it('carries the lowered capacity with the shift change, in one request', () => {
    expect(patchToSave(settings(), settings({ period2Enabled: false }))).toEqual({
      period2Enabled: false,
      defaultDayCapacity: 6,
    });
  });

  it('sends nothing at all when the draft matches what is stored', () => {
    // What a cancelled confirmation leaves behind: no shift change, so no request.
    expect(patchToSave(settings(), settings())).toEqual({});
  });

  it('does not touch the capacity the owner typed', () => {
    expect(patchToSave(settings(), settings({ defaultDayCapacity: 4 }))).toEqual({
      defaultDayCapacity: 4,
    });
  });
});

describe('capacitySlackMinutes', () => {
  it('reports the hours a day auto-fill leaves free', () => {
    expect(capacitySlackMinutes(settings({ defaultDayCapacity: 6 }))).toBe(240);
    expect(capacitySlackMinutes(settings())).toBe(0);
  });

  it('reports nothing for a capacity above the shift — that draft is asked about instead', () => {
    expect(capacitySlackMinutes(settings({ period2Enabled: false }))).toBe(0);
  });
});

describe('changedFields', () => {
  it('sends only what differs, so a PATCH never blanks a stored value', () => {
    const saved = settings();
    expect(changedFields(saved, settings({ gapColor: '#AABBCC' }))).toEqual({ gapColor: '#AABBCC' });
    expect(changedFields(saved, saved)).toEqual({});
  });
});

describe('draftIssues', () => {
  it('accepts the factory configuration', () => {
    expect(hasIssues(draftIssues(settings()))).toBe(false);
  });

  it('refuses a morning that ends before it starts', () => {
    expect(draftIssues(settings({ period1End: '07:00' })).period1End).toBe('morningOrder');
  });

  it('refuses an afternoon that starts before the morning ends', () => {
    expect(draftIssues(settings({ period2Start: '13:00' })).period2Start).toBe('afternoonStart');
  });

  it('ignores the afternoon times while the afternoon is off', () => {
    // Mirrors validateSettings: switching the afternoon off must not be blocked by the
    // times it happens to be holding.
    const draft = settings({ period2Enabled: false, period1End: '17:00' });
    expect(hasIssues(draftIssues(draft))).toBe(false);
  });

  it('refuses a margin above two hours and a fractional horizon', () => {
    expect(draftIssues(settings({ visualMarginTop: 3 })).visualMarginTop).toBe('range');
    expect(draftIssues(settings({ planningHorizonWeeks: 2.5 })).planningHorizonWeeks).toBe('range');
    expect(draftIssues(settings({ planningHorizonWeeks: 0 })).planningHorizonWeeks).toBe('range');
  });

  it('refuses a colour that is not #RRGGBB', () => {
    expect(draftIssues(settings({ gapColor: 'grey' })).gapColor).toBe('color');
  });
});

describe('the mirror of src/lib/settings.ts', () => {
  it('agrees with the server on the default shift and its ceiling', () => {
    // src/lib/settings.ts is the authority; this copy exists only because it cannot be
    // imported from a client component.
    const draft = settings();
    const shape = dayShapeFromSettings(draft);

    expect(shiftMinutesOf(draft)).toBe(shape.shiftMinutes);
    expect(maxCapacityHours(draft)).toBe(maxDayCapacityHours(draft));
    expect(periodsOf(draft)).toEqual(workPeriodsOf(draft));

    expect(timelineOf(draft)).toEqual({
      startMinutes: shape.timelineStartMinutes,
      endMinutes: shape.timelineEndMinutes,
    });
  });
});
