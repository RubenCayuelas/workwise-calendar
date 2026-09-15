import { describe, expect, it } from 'vitest';
import { manualWindowsOf } from '../../lib/manualWindow';
import type { DayShape, WorkPeriod } from '../../types';
import { axisTicks, createTimeline } from './geometry';
import { msUntilNextMinute, nowLinePlacement, type NowLineInput } from './nowLine';

const MORNING: WorkPeriod = { startMinutes: 8 * 60, endMinutes: 14 * 60 };
const AFTERNOON: WorkPeriod = { startMinutes: 15 * 60 + 30, endMinutes: 19 * 60 + 30 };

/** The documented shift: periods 08:00-14:00 and 15:30-19:30, margins 07:00 and 20:30. */
const SHAPE: DayShape = {
  periods: [MORNING, AFTERNOON],
  manualWindows: manualWindowsOf([MORNING, AFTERNOON], 60, 60),
  shiftMinutes: 600,
  capacityMinutes: 600,
  marginTopMinutes: 60,
  marginBottomMinutes: 60,
  timelineStartMinutes: 7 * 60,
  timelineEndMinutes: 20 * 60 + 30,
};

const TIMELINE = createTimeline(SHAPE, { pixelsPerHour: 60 });
const TICKS = axisTicks(SHAPE.periods, TIMELINE);

function place(over: Partial<NowLineInput> = {}): ReturnType<typeof nowLinePlacement> {
  return nowLinePlacement({
    enabled: true,
    nowMinutes: 10 * 60 + 20,
    timeline: TIMELINE,
    ticks: TICKS,
    ...over,
  });
}

describe('where the current-time line goes', () => {
  it('is not drawn at all when the setting is off', () => {
    expect(place({ enabled: false })).toBeNull();
  });

  it('is drawn on any week, because the hour it marks is the same on all of them', () => {
    expect(place()).not.toBeNull();
  });

  it('is not drawn before the axis begins or after it ends', () => {
    expect(place({ nowMinutes: 6 * 60 })).toBeNull();
    expect(place({ nowMinutes: 22 * 60 })).toBeNull();
  });

  it('sits at the axis position of the current minute', () => {
    expect(place()?.y).toBe(TIMELINE.yOf(10 * 60 + 20));
  });

  it('crosses the compressed lunch break like any other time', () => {
    expect(place({ nowMinutes: 14 * 60 + 45 })?.y).toBe(TIMELINE.yOf(14 * 60 + 45));
  });

  it('hides the hour label it would run through', () => {
    expect(TICKS.some((tick) => tick.minutes === 10 * 60)).toBe(true);
    expect(place({ nowMinutes: 10 * 60 + 2 })?.hiddenTickMinutes).toBe(10 * 60);
  });

  it('hides nothing when it falls clear of every label', () => {
    expect(place({ nowMinutes: 10 * 60 + 30 })?.hiddenTickMinutes).toBeNull();
  });
});

describe('when the mark is redrawn', () => {
  it('waits for the clock to turn over, not a whole minute from an arbitrary start', () => {
    expect(msUntilNextMinute(new Date(2026, 7, 12, 10, 20, 0, 0))).toBe(60_000);
    expect(msUntilNextMinute(new Date(2026, 7, 12, 10, 20, 59, 0))).toBe(1_000);
    expect(msUntilNextMinute(new Date(2026, 7, 12, 10, 20, 30, 250))).toBe(29_750);
  });
});
