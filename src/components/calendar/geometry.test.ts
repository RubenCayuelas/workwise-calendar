/**
 * The week grid's arithmetic, pinned.
 *
 * These two modules are pure on purpose: every block position, every drop target and
 * every grouped unit on screen comes out of them, and a mistake here moves the whole
 * calendar at once. The cases below are the ones that were reasoned about while building
 * the grid — the wireframe's axis, the lunch break, and the rank tie that makes a drop
 * look like it did nothing.
 */

import { describe, expect, it } from 'vitest';
import type { DayShape, Gap, WorkPeriod } from '../../types';
import type { WeekBlock } from '../../lib/api-client';
import {
  MAX_PIXELS_PER_HOUR,
  MIN_PIXELS_PER_HOUR,
  axisTicks,
  createTimeline,
  dateAtX,
  emptyLabelMinutes,
  maxDurationFrom,
  nonWorkingBands,
  rankFor,
  slotAt,
  snapTo,
} from './geometry';
import { assignLanes, groupBlocks, packDay, segmentsOf, workingMinutesBetween } from './grouping';

const MORNING: WorkPeriod = { startMinutes: 8 * 60, endMinutes: 14 * 60 };
const AFTERNOON: WorkPeriod = { startMinutes: 15 * 60 + 30, endMinutes: 19 * 60 + 30 };

/** The documented default: split shift 08:00-14:00 / 15:30-19:30, one hour of margin. */
const SHAPE: DayShape = {
  periods: [MORNING, AFTERNOON],
  shiftMinutes: 600,
  capacityMinutes: 600,
  marginTopMinutes: 60,
  marginBottomMinutes: 60,
  timelineStartMinutes: 7 * 60,
  timelineEndMinutes: 20 * 60 + 30,
};

describe('createTimeline', () => {
  it('maps the configured axis onto pixels', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });

    expect(timeline.startMinutes).toBe(420);
    expect(timeline.endMinutes).toBe(1230);
    expect(timeline.height).toBe(810);
    expect(timeline.yOf(420)).toBe(0);
    expect(timeline.yOf(480)).toBe(60);
    expect(timeline.heightOf(150)).toBe(150);
    expect(timeline.minutesAt(60)).toBe(480);
  });

  it('never draws a block outside the axis, however short', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    // 15 minutes at 60px/h is 15px, which is fine; a 0-minute row must still be visible
    // rather than collapse into nothing the owner cannot click.
    expect(timeline.heightOf(0)).toBe(1);
    expect(timeline.yOf(0)).toBe(0);
    expect(timeline.yOf(1440)).toBe(810);
  });

  it('grows to cover work placed outside the configured day', () => {
    // A block dropped by hand at 21:00, or left over from a longer working day.
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60, cover: [6 * 60 + 20, 21 * 60 + 15] });
    expect(timeline.startMinutes).toBe(6 * 60);
    expect(timeline.endMinutes).toBe(22 * 60);
  });

  it('fits the height it is given, within bounds', () => {
    // 13.5 h in 675px is exactly 50px/h.
    expect(createTimeline(SHAPE, { fitHeight: 675 }).pixelsPerMinute * 60).toBeCloseTo(50);
    // A tiny window scrolls rather than collapsing the day.
    expect(createTimeline(SHAPE, { fitHeight: 100 }).pixelsPerMinute * 60).toBe(MIN_PIXELS_PER_HOUR);
    // A very tall one stops stretching.
    expect(createTimeline(SHAPE, { fitHeight: 4000 }).pixelsPerMinute * 60).toBe(MAX_PIXELS_PER_HOUR);
  });

  it('clamps a start so the row still fits inside the day', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    expect(timeline.clampStart(1200, 120)).toBe(1230 - 120);
    expect(timeline.clampStart(0, 120)).toBe(420);
  });

  it('survives a degenerate configuration instead of dividing by zero', () => {
    const timeline = createTimeline({ ...SHAPE, timelineStartMinutes: 600, timelineEndMinutes: 600 });
    expect(timeline.spanMinutes).toBe(60);
    expect(Number.isFinite(timeline.height)).toBe(true);
  });
});

describe('nonWorkingBands', () => {
  it('greys the two margins and the lunch break', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    expect(nonWorkingBands(SHAPE.periods, timeline)).toEqual([
      { kind: 'marginTop', startMinutes: 420, endMinutes: 480 },
      { kind: 'lunch', startMinutes: 840, endMinutes: 930 },
      { kind: 'marginBottom', startMinutes: 1170, endMinutes: 1230 },
    ]);
  });

  it('has no lunch band when the afternoon is switched off', () => {
    const shape: DayShape = { ...SHAPE, periods: [MORNING], timelineEndMinutes: 15 * 60 };
    const bands = nonWorkingBands(shape.periods, createTimeline(shape, { pixelsPerHour: 60 }));
    expect(bands.map((band) => band.kind)).toEqual(['marginTop', 'marginBottom']);
  });
});

describe('emptyLabelMinutes', () => {
  it('sits in the middle of the morning, not on the 14:00 rule', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    // The column's own midpoint is 13:45 — fifteen minutes above the boundary and on
    // the edge of the lunch band, which is why "libre" read as debris. 11:00 is inside
    // the day's longest working stretch, clear of every band and every rule.
    expect(emptyLabelMinutes(SHAPE.periods, timeline)).toBe(11 * 60);
    expect(emptyLabelMinutes(SHAPE.periods, timeline)).not.toBe(
      (timeline.startMinutes + timeline.endMinutes) / 2,
    );
  });

  it('follows the longest period when the afternoon is the long one', () => {
    const periods: WorkPeriod[] = [
      { startMinutes: 8 * 60, endMinutes: 10 * 60 },
      { startMinutes: 12 * 60, endMinutes: 20 * 60 },
    ];
    const timeline = createTimeline({ ...SHAPE, periods }, { pixelsPerHour: 60 });
    expect(emptyLabelMinutes(periods, timeline)).toBe(16 * 60);
  });

  it('falls back to the middle of the axis on a day with no working stretch', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    expect(emptyLabelMinutes([], timeline)).toBe((timeline.startMinutes + timeline.endMinutes) / 2);
  });
});

describe('axisTicks', () => {
  it('labels exactly what the wireframe labels', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    // 07:00 08:00 11:00 14:00 15:30 17:30 19:30 20:30 — the edges of the day plus an
    // interior tick wherever a period would otherwise run more than three hours unlabelled.
    expect(axisTicks(SHAPE.periods, timeline).map((tick) => tick.minutes)).toEqual([
      420, 480, 660, 840, 930, 1050, 1170, 1230,
    ]);
  });

  it('marks the edges of the day as boundaries and the rest as interior', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    const ticks = new Map(axisTicks(SHAPE.periods, timeline).map((tick) => [tick.minutes, tick.boundary]));
    expect(ticks.get(480)).toBe(true);
    expect(ticks.get(660)).toBe(false);
    expect(ticks.get(1050)).toBe(false);
  });
});

describe('drop targets', () => {
  const columns = [
    { date: '2026-08-10', left: 100, width: 200 },
    { date: '2026-08-11', left: 300, width: 200 },
    { date: '2026-08-15', left: 500, width: 100 },
  ];

  it('finds the column under the pointer, and none outside the grid', () => {
    expect(dateAtX(150, columns)).toBe('2026-08-10');
    expect(dateAtX(300, columns)).toBe('2026-08-11');
    expect(dateAtX(560, columns)).toBe('2026-08-15');
    expect(dateAtX(90, columns)).toBeUndefined();
    expect(dateAtX(700, columns)).toBeUndefined();
  });

  it('snaps a drop to the quarter hour', () => {
    expect(snapTo(487)).toBe(480);
    expect(snapTo(496)).toBe(495);
  });

  it('reads a pointer position as a date and a minute', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    const hit = slotAt({ x: 350, y: 1000 + 67 }, { top: 1000, columns }, timeline);
    expect(hit).toEqual({ date: '2026-08-11', exactMinutes: 487, snappedMinutes: 480 });
  });

  it('breaks a rank tie away from the row it landed on', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    // No tie: the snapped value stands.
    expect(rankFor(480, 483, [600], timeline)).toBe(480);
    // Pointer ABOVE the existing start means "before it".
    expect(rankFor(480, 477, [480], timeline)).toBe(479);
    // Pointer BELOW means "after it".
    expect(rankFor(480, 484, [480], timeline)).toBe(481);
    // A tie on the very first minute of the axis can only go the other way.
    expect(rankFor(420, 418, [420], timeline)).toBe(421);
  });
});

describe('maxDurationFrom', () => {
  it('stops a row at the end of its own period, never across the lunch break', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    expect(maxDurationFrom(12 * 60, SHAPE.periods, timeline)).toBe(120);
    expect(maxDurationFrom(18 * 60, SHAPE.periods, timeline)).toBe(90);
  });

  it('stops a row started in a margin at the next period', () => {
    const timeline = createTimeline(SHAPE, { pixelsPerHour: 60 });
    expect(maxDurationFrom(7 * 60, SHAPE.periods, timeline)).toBe(60);
    // Inside the lunch break: up to the afternoon's start.
    expect(maxDurationFrom(14 * 60 + 30, SHAPE.periods, timeline)).toBe(60);
    // After the last period: the rest of the axis.
    expect(maxDurationFrom(20 * 60, SHAPE.periods, timeline)).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

let sequence = 0;

function block(partial: Partial<WeekBlock> & { startMinutes: number; durationMinutes: number }): WeekBlock {
  sequence += 1;
  const projectId = partial.projectId ?? 'job-a';
  return {
    id: partial.id ?? `block-${sequence}`,
    projectId,
    date: partial.date ?? '2026-08-11',
    startMinutes: partial.startMinutes,
    durationMinutes: partial.durationMinutes,
    locked: partial.locked ?? false,
    manualDuration: partial.manualDuration ?? false,
    handPlaced: partial.handPlaced ?? false,
    createdAt: partial.createdAt ?? `2026-08-11 08:00:0${sequence}`,
    updatedAt: partial.updatedAt ?? '2026-08-11 08:00:00',
    project: partial.project ?? { id: projectId, name: projectId, color: '#185FA5' },
  };
}

describe('workingMinutesBetween', () => {
  it('is zero across the lunch break and across a margin', () => {
    expect(workingMinutesBetween(SHAPE.periods, 840, 930)).toBe(0);
    expect(workingMinutesBetween(SHAPE.periods, 1170, 1230)).toBe(0);
  });

  it('counts the working time a gap in the middle of a period holds', () => {
    expect(workingMinutesBetween(SHAPE.periods, 660, 720)).toBe(60);
  });
});

describe('groupBlocks', () => {
  it('joins the two halves of a job around the lunch break into one unit', () => {
    const groups = groupBlocks(
      [
        block({ startMinutes: 780, durationMinutes: 60 }),
        block({ startMinutes: 930, durationMinutes: 120 }),
      ],
      SHAPE.periods,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].totalMinutes).toBe(180);
    expect(groups[0].startMinutes).toBe(780);
    expect(groups[0].endMinutes).toBe(1050);
    expect(segmentsOf(groups).map((segment) => [segment.isFirst, segment.isLast])).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  it('does not join two jobs that merely touch', () => {
    const groups = groupBlocks(
      [
        block({ projectId: 'job-a', startMinutes: 480, durationMinutes: 120 }),
        block({ projectId: 'job-b', startMinutes: 600, durationMinutes: 120 }),
      ],
      SHAPE.periods,
    );
    expect(groups).toHaveLength(2);
  });

  it('does not join across a break that holds working time', () => {
    // Same job at 08:00-10:00 and 11:00-12:00: an hour of working time sits between
    // them (a gap, or another job), so they are two units.
    const groups = groupBlocks(
      [
        block({ startMinutes: 480, durationMinutes: 120 }),
        block({ startMinutes: 660, durationMinutes: 60 }),
      ],
      SHAPE.periods,
    );
    expect(groups).toHaveLength(2);
  });

  it('reports a unit as locked only when every one of its rows is', () => {
    const groups = groupBlocks(
      [
        block({ startMinutes: 780, durationMinutes: 60, locked: true }),
        block({ startMinutes: 930, durationMinutes: 120, locked: false }),
      ],
      SHAPE.periods,
    );
    expect(groups[0].locked).toBe(false);
  });
});

describe('lanes', () => {
  it('leaves a day with no overlap at full width', () => {
    const placements = assignLanes([
      { id: 'a', startMinutes: 480, endMinutes: 600 },
      { id: 'b', startMinutes: 600, endMinutes: 720 },
    ]);
    expect([...placements.values()]).toEqual([
      { lane: 0, lanes: 1 },
      { lane: 0, lanes: 1 },
    ]);
  });

  it('splits the column between rows that overlap, which only a human can create', () => {
    const placements = assignLanes([
      { id: 'a', startMinutes: 480, endMinutes: 660 },
      { id: 'b', startMinutes: 540, endMinutes: 720 },
    ]);
    expect(placements.get('a')).toEqual({ lane: 0, lanes: 2 });
    expect(placements.get('b')).toEqual({ lane: 1, lanes: 2 });
  });

  it('packs gaps and blocks together, since they share the column', () => {
    const gap: Gap = {
      id: 'gap-1',
      date: '2026-08-11',
      startMinutes: 540,
      durationMinutes: 60,
      createdAt: '2026-08-11 08:00:00',
      updatedAt: '2026-08-11 08:00:00',
    };
    const groups = groupBlocks([block({ startMinutes: 480, durationMinutes: 120 })], SHAPE.periods);
    const placements = packDay(groups, [gap]);
    expect(placements.get(groups[0].id)?.lanes).toBe(2);
    expect(placements.get('gap-1')?.lanes).toBe(2);
  });
});
