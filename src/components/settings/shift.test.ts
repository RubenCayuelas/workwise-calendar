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
  changedFields,
  draftIssues,
  hasIssues,
  lunchOf,
  maxCapacityHours,
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
    // 07:00 to 20:30, exactly the timeline in CLAUDE.md's diagram.
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
  it('re-caps the capacity when the afternoon is switched off, and says so', () => {
    const result = applySettingsPatch(settings(), { period2Enabled: false });
    expect(result.settings.defaultDayCapacity).toBe(6);
    expect(result.recappedToHours).toBe(6);
  });

  it('re-caps the capacity when the morning is shortened', () => {
    const result = applySettingsPatch(settings({ period2Enabled: false }), { period1End: '12:00' });
    expect(result.settings.defaultDayCapacity).toBe(4);
    expect(result.recappedToHours).toBe(4);
  });

  it('does not announce a re-cap when the capacity field is what was edited', () => {
    // The field already shows its own maximum; a notice would be noise.
    const result = applySettingsPatch(settings(), { defaultDayCapacity: 6 });
    expect(result.settings.defaultDayCapacity).toBe(6);
    expect(result.recappedToHours).toBeUndefined();
  });

  it('leaves an untouched capacity alone when the shift grows', () => {
    const result = applySettingsPatch(settings({ defaultDayCapacity: 8 }), { period2End: '20:30' });
    expect(result.settings.defaultDayCapacity).toBe(8);
    expect(result.recappedToHours).toBeUndefined();
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
    // The one guard against the two copies of this arithmetic drifting apart. src/lib/
    // settings.ts is the authority; this file only exists because it cannot be imported
    // from a client component.
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
