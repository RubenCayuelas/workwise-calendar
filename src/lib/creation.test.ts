import { beforeEach, describe, expect, it } from 'vitest';
import { compareDates, hhmmToMinutes as t, minutesToHHmm } from './dates';
import { DEFAULT_SETTINGS, dayShapeFromSettings } from './settings';
import { manualWindowsOf } from './manualWindow';
import { compose, createDayConfigResolver, type ComposeInput, type ComposeResult } from './composition';
import { decideStartDate, planCreation, type CreationPlan, type CreationResult } from './creation';
import type { Block, DayOverride, DayShape, Gap } from '../types';
import { FAR_MON, FRI, LAST_WED, MON, NEXT_MON, NEXT_THU, NEXT_TUE, NEXT_WED, SAT, SUN, THU, TUE, WED } from '../testing/fixtures';

/** The week under test is the wireframe's, and today is the Wednesday inside it. */

const PERIODS = [
  { startMinutes: t('08:00'), endMinutes: t('14:00') },
  { startMinutes: t('15:30'), endMinutes: t('19:30') },
];

const SHAPE: DayShape = {
  periods: PERIODS,
  // Derived, exactly as `dayShapeFromSettings` derives it: 07:00-14:00 and 15:30-20:30.
  manualWindows: manualWindowsOf(PERIODS, 60, 60),
  shiftMinutes: 600,
  capacityMinutes: 600,
  marginTopMinutes: 60,
  marginBottomMinutes: 60,
  timelineStartMinutes: t('07:00'),
  timelineEndMinutes: t('20:30'),
};

let sequence = 0;

beforeEach(() => {
  sequence = 0;
});

function stamp(index: number): string {
  return new Date(Date.UTC(2026, 7, 1, 8, 0, 0) + index * 60_000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
}

interface BlockSpec {
  project: string;
  date: string;
  from: string;
  hours: number;
  locked?: boolean;
}

function block(spec: BlockSpec): Block {
  const index = ++sequence;
  return {
    id: `b${index}`,
    projectId: spec.project,
    date: spec.date,
    startMinutes: t(spec.from),
    durationMinutes: Math.round(spec.hours * 60),
    locked: spec.locked ?? false,
    createdAt: stamp(index),
    updatedAt: stamp(index),
  };
}

function gap(spec: { date: string; from: string; hours: number }): Gap {
  const index = ++sequence;
  return {
    id: `g${index}`,
    unitId: `g${index}`,
    date: spec.date,
    startMinutes: t(spec.from),
    durationMinutes: Math.round(spec.hours * 60),
    createdAt: stamp(index),
    updatedAt: stamp(index),
  };
}

function input(spec: {
  today?: string;
  blocks?: Block[];
  gaps?: Gap[];
  shape?: DayShape;
  overrides?: DayOverride[];
}): ComposeInput {
  return {
    today: spec.today ?? WED,
    blocks: spec.blocks ?? [],
    gaps: spec.gaps ?? [],
    getDayConfig: createDayConfigResolver(spec.shape ?? SHAPE, spec.overrides ?? []),
    planningHorizonWeeks: DEFAULT_SETTINGS.planningHorizonWeeks,
  };
}

/** The new job, always `new`, so a row's project name reads as itself in a failure. */
function plan(
  composeInput: ComposeInput,
  request: { startDate: string; hours: number; force?: boolean },
): CreationResult {
  let minted = 0;
  return planCreation(composeInput, {
    projectId: 'new',
    minutes: Math.round(request.hours * 60),
    blockId: 'n1',
    newBlockId: () => `n${++minted + 1}`,
    now: stamp(99),
    startDate: request.startDate,
    force: request.force,
  });
}

/** A band painted at an exact minute: the same request, plus the minute the release names. */
function paint(
  composeInput: ComposeInput,
  request: { startDate: string; from: string; hours: number },
): CreationResult {
  let minted = 0;
  return planCreation(composeInput, {
    projectId: 'new',
    minutes: Math.round(request.hours * 60),
    blockId: 'n1',
    newBlockId: () => `n${++minted + 1}`,
    now: stamp(99),
    startDate: request.startDate,
    startMinutes: t(request.from),
  });
}

function expectOk(result: CreationResult): CreationPlan {
  if (!result.ok) throw new Error(`expected a plan, got "${result.error.code}"`);
  return result;
}

/** The NEW job's rows only: where the hours were born. */
function rows(result: CreationResult): string[] {
  return expectOk(result).placed.map(
    (row) =>
      `${row.date} ${minutesToHHmm(row.startMinutes)}-${minutesToHHmm(
        row.startMinutes + row.durationMinutes,
      )}${row.locked ? ' [locked]' : ''}`,
  );
}

/** Every row of a composed calendar, so two passes can be compared line for line. */
function lines(result: ComposeResult): string[] {
  if (!result.ok) throw new Error(`expected a placement, got "${result.error.code}"`);
  return result.blocks.map(
    (row) =>
      `${row.date} ${minutesToHHmm(row.startMinutes)}-${minutesToHHmm(
        row.startMinutes + row.durationMinutes,
      )} ${row.projectId}${row.locked ? ' [locked]' : ''}`,
  );
}

/** Feeds a placement back in, so the engine can be asked to recompose its own output. */
function reload(result: ComposeResult): Block[] {
  if (!result.ok) throw new Error(`expected a placement, got "${result.error.code}"`);
  return result.blocks.map((row, index) => ({
    id: row.id ?? `inserted-${index}`,
    projectId: row.projectId,
    date: row.date,
    startMinutes: row.startMinutes,
    durationMinutes: row.durationMinutes,
    locked: row.locked,
    createdAt: stamp(index),
    updatedAt: stamp(index),
  }));
}

/** What the caller would write, as the whole calendar: hours must be conserved. */
function minutesOf(result: CreationResult, projectId: string): number {
  return expectOk(result)
    .blocks.filter((row) => row.projectId === projectId)
    .reduce((total, row) => total + row.durationMinutes, 0);
}

// ---------------------------------------------------------------------------

describe('deciding what a start date means', () => {
  /** Work planned to Thursday; an appended job would start on Thursday afternoon. */
  const question = {
    startDate: NEXT_MON,
    today: WED,
    lastOccupiedDate: THU,
    role: 'auto' as const,
    isClosed: false,
    queueStartDate: THU,
  };

  it('is a floor, not a booking: while the queue reaches it the job joins the queue', () => {
    const decision = decideStartDate({
      ...question,
      startDate: WED,
      lastOccupiedDate: NEXT_TUE,
      queueStartDate: NEXT_TUE,
    });

    expect(decision.mode).toBe('queue');
    expect(decision.floorBinding).toBe(false);
    expect(decision.autoLock).toBe(false);
    expect(decision.beyondQueue).toBe(false);
  });

  it('locks every row when the date is beyond the work planned', () => {
    const decision = decideStartDate({ ...question, startDate: NEXT_WED, queueStartDate: THU });

    expect(decision.mode).toBe('born');
    expect(decision.beyondQueue).toBe(true);
    expect(decision.floorBinding).toBe(true);
    expect(decision.autoLock).toBe(true);
  });

  it('does NOT lock on the boundary: the chosen day IS the last occupied day', () => {
    const decision = decideStartDate({ ...question, startDate: THU, queueStartDate: THU });

    expect(decision.beyondQueue).toBe(false);
    expect(decision.floorBinding).toBe(false);
    expect(decision.autoLock).toBe(false);
    expect(decision.mode).toBe('queue');
  });

  it('locks the day after the boundary, and only that changes', () => {
    const day = (startDate: string): boolean =>
      decideStartDate({ ...question, startDate, queueStartDate: THU }).autoLock;

    expect(day(THU)).toBe(false);
    expect(day(FRI)).toBe(true);
  });

  it('measures the floor against where the ENGINE would fill, not the last row', () => {
    // A lone locked row far out: the engine would still fill Wednesday first.
    const decision = decideStartDate({
      ...question,
      startDate: NEXT_TUE,
      lastOccupiedDate: NEXT_TUE,
      queueStartDate: WED,
    });

    expect(decision.beyondQueue).toBe(false);
    expect(decision.floorBinding).toBe(true);
    expect(decision.autoLock).toBe(true);
  });

  it('treats a clear calendar as "the engine would start today"', () => {
    expect(
      decideStartDate({ ...question, startDate: WED, lastOccupiedDate: null, queueStartDate: WED })
        .autoLock,
    ).toBe(false);
    expect(
      decideStartDate({ ...question, startDate: THU, lastOccupiedDate: null, queueStartDate: WED })
        .autoLock,
    ).toBe(true);
  });

  it('padlocks the rows born on the buffer and the weekend, and asks for a confirmation', () => {
    const friday = decideStartDate({ ...question, startDate: FRI, role: 'buffer' });
    const saturday = decideStartDate({ ...question, startDate: SAT, role: 'manual' });

    expect([friday.day, saturday.day]).toEqual(['buffer', 'weekend']);
    expect([friday.dayLock, saturday.dayLock]).toEqual([true, true]);
    expect([friday.needsDayConfirmation, saturday.needsDayConfirmation]).toEqual([true, true]);
    expect([friday.mode, saturday.mode]).toEqual(['born', 'born']);
  });

  it('allows the past and locks it: a job done but never logged', () => {
    const decision = decideStartDate({ ...question, startDate: LAST_WED, queueStartDate: THU });

    expect(decision.day).toBe('past');
    expect(decision.mode).toBe('born');
    // The floor does not bind — the queue lands later — but the past is locked anyway.
    expect(decision.floorBinding).toBe(false);
    expect(decision.autoLock).toBe(true);
    // Nothing to confirm: the past is not a day the engine would take back.
    expect(decision.needsDayConfirmation).toBe(false);
  });

  it('forces only where the engine would otherwise defer the job', () => {
    expect(
      decideStartDate({
        ...question,
        startDate: WED,
        lastOccupiedDate: NEXT_TUE,
        queueStartDate: NEXT_TUE,
        force: true,
      }).mode,
    ).toBe('forced');
    // Beyond the queue there is nothing to force: the job is born there anyway.
    expect(decideStartDate({ ...question, startDate: NEXT_WED, force: true }).mode).toBe('born');
  });

  it('names the weekend before a closed day, since that is the fact that binds', () => {
    expect(decideStartDate({ ...question, startDate: SAT, isClosed: true }).day).toBe('weekend');
    expect(decideStartDate({ ...question, startDate: NEXT_MON, isClosed: true }).day).toBe('closed');
  });

  it('padlocks a closed day and asks for a confirmation, exactly as the weekend does', () => {
    // The floor does NOT bind here — the queue lands later — so `closed` is the only thing that
    // can make this born. Before 2026-08-20 it could not, and the job started the first open day.
    const decision = decideStartDate({
      ...question,
      startDate: WED,
      lastOccupiedDate: NEXT_TUE,
      queueStartDate: NEXT_TUE,
      isClosed: true,
    });

    expect(decision.day).toBe('closed');
    expect(decision.floorBinding).toBe(false);
    expect(decision.mode).toBe('born');
    expect(decision.dayLock).toBe(true);
    expect(decision.needsDayConfirmation).toBe(true);
  });
});

describe('a date the queue already runs past', () => {
  const calendar = input({
    blocks: [
      block({ project: 'bar', date: WED, from: '08:00', hours: 6 }),
      block({ project: 'bar', date: WED, from: '15:30', hours: 4 }),
      block({ project: 'bar', date: THU, from: '08:00', hours: 6 }),
    ],
  });

  it('lands at the end of the queue and says it was deferred', () => {
    const result = plan(calendar, { startDate: WED, hours: 4 });

    expect(expectOk(result).decision.mode).toBe('queue');
    expect(expectOk(result).deferred).toBe(true);
    expect(expectOk(result).canForce).toBe(true);
    expect(rows(result)).toEqual([`${THU} 15:30-19:30`]);
  });

  it('reports what sits across the WHOLE span it would have occupied, not just day one', () => {
    // 20 h from Wednesday spans Wed, Thu and next Monday at 10 h a day.
    const result = plan(calendar, { startDate: WED, hours: 20 });
    const collisions = expectOk(result).collisions;

    // Forced, the job would take Wednesday and Thursday, pushing Railing forward.
    expect(expectOk(result).span).toEqual({ startDate: WED, endDate: THU });
    expect(collisions.map((item) => `${item.date} ${item.projectId} ${item.minutes}`)).toEqual([
      `${WED} bar 600`,
      `${THU} bar 360`,
    ]);
  });

  it('offers the days with nothing on them', () => {
    const result = plan(calendar, { startDate: WED, hours: 4 });

    // Wednesday and Thursday carry work; Friday is the buffer and the weekend is out.
    expect(expectOk(result).freeDates.slice(0, 3)).toEqual([NEXT_MON, NEXT_TUE, NEXT_WED]);
  });

  it('places the job on the chosen day when forced, and pushes what follows', () => {
    const result = plan(calendar, { startDate: WED, hours: 4, force: true });

    expect(expectOk(result).decision.mode).toBe('forced');
    expect(expectOk(result).deferred).toBe(false);
    expect(rows(result)).toEqual([`${WED} 08:00-12:00`]);
    // Nothing is padlocked: it is a queue rank, exactly like a drag.
    expect(expectOk(result).placed.every((row) => !row.locked)).toBe(true);
    expect(minutesOf(result, 'bar')).toBe(16 * 60);
  });
});

describe('a date beyond everything planned', () => {
  const calendar = input({
    blocks: [block({ project: 'bar', date: WED, from: '08:00', hours: 6 })],
  });

  it('is born there, with every row locked', () => {
    const result = plan(calendar, { startDate: NEXT_TUE, hours: 4 });

    expect(expectOk(result).decision.autoLock).toBe(true);
    expect(rows(result)).toEqual([`${NEXT_TUE} 08:00-12:00 [locked]`]);
    expect(expectOk(result).deferred).toBe(false);
  });

  it('is the engine that lays it out: the lunch break cuts it, capacity caps the day', () => {
    const result = plan(calendar, { startDate: NEXT_TUE, hours: 14 });

    expect(rows(result)).toEqual([
      `${NEXT_TUE} 08:00-14:00 [locked]`,
      `${NEXT_TUE} 15:30-19:30 [locked]`,
      `${NEXT_WED} 08:00-12:00 [locked]`,
    ]);
    expect(minutesOf(result, 'new')).toBe(14 * 60);
  });

  it('skips the Friday buffer on the way forward, like any new job', () => {
    const result = plan(calendar, { startDate: NEXT_WED, hours: 24 });

    expect(rows(result)).toEqual([
      `${NEXT_WED} 08:00-14:00 [locked]`,
      `${NEXT_WED} 15:30-19:30 [locked]`,
      `${NEXT_THU} 08:00-14:00 [locked]`,
      `${NEXT_THU} 15:30-19:30 [locked]`,
      // Friday the 21st is skipped: the buffer never takes new work.
      `2026-08-24 08:00-12:00 [locked]`,
    ]);
  });

  it('flows around a gap on the chosen day', () => {
    const withGap = input({
      blocks: calendar.blocks as Block[],
      gaps: [gap({ date: FAR_MON, from: '10:00', hours: 2 })],
    });
    const result = plan(withGap, { startDate: FAR_MON, hours: 4 });

    // Fill and overflow: the two hours in front of the gap, then the rest after it.
    expect(rows(result)).toEqual([`${FAR_MON} 08:00-10:00 [locked]`, `${FAR_MON} 12:00-14:00 [locked]`]);
  });

  it('reports nothing in the way, because there is nothing there', () => {
    const result = plan(calendar, { startDate: FAR_MON, hours: 4 });

    expect(expectOk(result).collisions).toEqual([]);
  });
});

describe('the buffer, the weekend and the past', () => {
  const calendar = input({
    blocks: [
      block({ project: 'bar', date: WED, from: '08:00', hours: 6 }),
      block({ project: 'bar', date: WED, from: '15:30', hours: 4 }),
      block({ project: 'bar', date: THU, from: '08:00', hours: 6 }),
      block({ project: 'bar', date: NEXT_MON, from: '08:00', hours: 6 }),
      block({ project: 'bar', date: NEXT_TUE, from: '08:00', hours: 6 }),
    ],
  });

  it('honours a Friday and padlocks the row, though the floor itself does not bind', () => {
    const result = plan(calendar, { startDate: FRI, hours: 4 });

    expect(expectOk(result).decision.day).toBe('buffer');
    expect(rows(result)[0]).toBe(`${FRI} 08:00-12:00 [locked]`);
    // `autoLock` is the other reason to padlock: the queue not reaching the day at all.
    expect(expectOk(result).decision.autoLock).toBe(false);
    expect(expectOk(result).decision.dayLock).toBe(true);
  });

  it('honours a Saturday, where the engine would place nothing at all', () => {
    const result = plan(calendar, { startDate: SAT, hours: 4 });

    expect(rows(result)[0]).toBe(`${SAT} 08:00-12:00 [locked]`);
    expect(expectOk(result).decision.needsDayConfirmation).toBe(true);
  });

  it('records the past where it happened, locked, without touching what is there', () => {
    const withPast = input({
      blocks: [...(calendar.blocks as Block[]), block({ project: 'bar', date: LAST_WED, from: '08:00', hours: 2 })],
    });
    const result = plan(withPast, { startDate: LAST_WED, hours: 3 });

    // It flows around the row that is already on that past day rather than over it.
    expect(rows(result)).toEqual([`${LAST_WED} 10:00-13:00 [locked]`]);
    expect(minutesOf(result, 'bar')).toBe(30 * 60);
  });

  it('padlocks the chosen day only: the tail is the engine\'s day, not the owner\'s', () => {
    const result = plan(calendar, { startDate: SAT, hours: 14 });
    const placed = expectOk(result).placed;

    expect(placed.filter((row) => row.date === SAT).map((row) => row.locked)).toEqual([
      true,
      true,
    ]);
    expect(placed.filter((row) => row.date !== SAT).every((row) => !row.locked)).toBe(true);
    expect(placed.some((row) => row.date !== SAT)).toBe(true);
    expect(minutesOf(result, 'new')).toBe(14 * 60);
  });
});

describe('a band painted at an exact minute', () => {
  /** Mornings taken to NEXT_MON, afternoons free: the holes a paint is actually aimed at. */
  const busyMornings = input({
    blocks: [
      block({ project: 'bar', date: WED, from: '08:00', hours: 6 }),
      block({ project: 'bar', date: THU, from: '08:00', hours: 6 }),
      block({ project: 'bar', date: NEXT_MON, from: '08:00', hours: 6 }),
    ],
  });

  it('starts on the minute it was painted on, padlocked', () => {
    const result = paint(busyMornings, { startDate: THU, from: '16:00', hours: 2 });

    expect(rows(result)).toEqual([`${THU} 16:00-18:00 [locked]`]);
  });

  it('padlocks on Monday-Thursday inside the periods, where a DROP deliberately does not', () => {
    // The one place this gesture departs from the drop path: without the padlock the reflow would
    // pull the row off the minute the band was drawn on and the band would have lied.
    const result = paint(busyMornings, { startDate: THU, from: '16:00', hours: 2 });

    expect(expectOk(result).placed.every((row) => row.locked)).toBe(true);
  });

  it('is cut at the lunch break, so no stored row straddles it', () => {
    const result = paint(input({}), { startDate: NEXT_TUE, from: '13:00', hours: 3 });

    expect(rows(result)).toEqual([
      `${NEXT_TUE} 13:00-14:00 [locked]`,
      `${NEXT_TUE} 15:30-17:30 [locked]`,
    ]);
  });

  it('may take margin time, which is workable time the owner chose', () => {
    const result = paint(input({}), { startDate: NEXT_TUE, from: '19:00', hours: 1.5 });

    expect(rows(result)).toEqual([`${NEXT_TUE} 19:00-20:30 [locked]`]);
  });

  it('reads a release inside the lunch break as the afternoon', () => {
    const result = paint(input({}), { startDate: NEXT_TUE, from: '14:30', hours: 2 });

    expect(rows(result)).toEqual([`${NEXT_TUE} 15:30-17:30 [locked]`]);
  });

  it('THE FORM\'S HOURS WIN: the band sets the start, the number sets the length', () => {
    const result = paint(input({}), { startDate: NEXT_TUE, from: '10:00', hours: 12 });
    const placed = expectOk(result).placed;
    const onDay = placed.filter((row) => row.date === NEXT_TUE);

    // 10:00 leaves 4 h + 5 h of the manual window; the other 3 h carry on.
    expect(onDay.reduce((total, row) => total + row.durationMinutes, 0)).toBe(9 * 60);
    expect(minutesOf(result, 'new')).toBe(12 * 60);
    expect(placed.some((row) => row.date !== NEXT_TUE)).toBe(true);
  });

  it('NEVER puts the overflow in front of the band it came from', () => {
    // The guard that matters most: `rankedRow` writes a rank at 00:00, so anchoring the tail on the
    // painted day laid 3 h at NEXT_TUE 08:00 — padlocked, in front of a band drawn at 17:00.
    const result = paint(input({}), { startDate: NEXT_TUE, from: '17:00', hours: 6 });
    const placed = expectOk(result).placed;

    expect(placed[0].date).toBe(NEXT_TUE);
    expect(placed[0].startMinutes).toBe(t('17:00'));
    for (const row of placed) {
      expect(compareDates(row.date, NEXT_TUE)).toBeGreaterThanOrEqual(0);
      if (row.date === NEXT_TUE) expect(row.startMinutes).toBeGreaterThanOrEqual(t('17:00'));
    }
    expect(minutesOf(result, 'new')).toBe(6 * 60);
  });

  it('leaves the tail to the engine when the floor does not bind', () => {
    // The queue reaches past the painted day, so nothing but the owner's minute holds the head.
    const result = paint(busyMornings, { startDate: WED, from: '16:00', hours: 8 });
    const placed = expectOk(result).placed;

    expect(placed.filter((row) => row.date === WED).every((row) => row.locked)).toBe(true);
    expect(placed.filter((row) => row.date !== WED).every((row) => !row.locked)).toBe(true);
  });

  it('padlocks the tail too where the queue would never have reached that day', () => {
    const result = paint(input({}), { startDate: FAR_MON, from: '17:00', hours: 6 });

    expect(expectOk(result).decision.autoLock).toBe(true);
    expect(expectOk(result).placed.every((row) => row.locked)).toBe(true);
  });

  it('still asks before painting on the buffer or the weekend', () => {
    for (const date of [FRI, SAT]) {
      const result = paint(input({}), { startDate: date, from: '10:00', hours: 2 });

      expect(expectOk(result).decision.needsDayConfirmation).toBe(true);
      expect(rows(result)[0]).toBe(`${date} 10:00-12:00 [locked]`);
    }
  });

  it('is refused when it lands on a gap, naming nothing else', () => {
    const withGap = input({ gaps: [gap({ date: NEXT_TUE, from: '10:00', hours: 2 })] });
    const result = paint(withGap, { startDate: NEXT_TUE, from: '11:00', hours: 2 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('painted-over-gap');
  });

  it('is refused when it lands on a row the engine cannot move', () => {
    const withLock = input({
      blocks: [block({ project: 'bar', date: NEXT_TUE, from: '10:00', hours: 2, locked: true })],
    });
    const result = paint(withLock, { startDate: NEXT_TUE, from: '11:00', hours: 2 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('painted-over-fixed-block');
      expect(result.error.projectId).toBe('bar');
    }
  });

  it('does NOT refuse over ordinary work: the reflow pushes that forward', () => {
    const withWork = input({
      blocks: [block({ project: 'bar', date: NEXT_TUE, from: '10:00', hours: 2 })],
    });
    const result = paint(withWork, { startDate: NEXT_TUE, from: '11:00', hours: 2 });

    expect(result.ok).toBe(true);
    expect(rows(result)).toEqual([`${NEXT_TUE} 11:00-13:00 [locked]`]);
  });

  it('asks the refusal of every ROW it will be stored as, not of the clock span', () => {
    // 13:00 +3 h is stored 13:00-14:00 and 15:30-17:30. Measured over `start + duration` the test
    // would cover 13:00-16:00 and MISS a padlocked row at 16:30.
    const withLock = input({
      blocks: [block({ project: 'bar', date: NEXT_TUE, from: '16:30', hours: 1, locked: true })],
    });
    const result = paint(withLock, { startDate: NEXT_TUE, from: '13:00', hours: 3 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('painted-over-fixed-block');
  });

  it('reports the painted mode, and never offers to force it', () => {
    const result = expectOk(paint(input({}), { startDate: NEXT_TUE, from: '10:00', hours: 2 }));

    expect(result.decision.mode).toBe('painted');
    expect(result.canForce).toBe(false);
    expect(result.deferred).toBe(false);
  });
});

describe('a closed day chosen as the start date', () => {
  const CLOSED = { date: NEXT_TUE, isClosed: true, capacityHours: null, note: 'Festivo' };

  /**
   * Work to NEXT_MON, so an appended job would start on NEXT_WED — the closed Tuesday is skipped.
   * The floor therefore does NOT bind on NEXT_TUE, which is what isolates the closed day as the
   * only reason the job is born there.
   */
  const calendar = input({
    blocks: [
      block({ project: 'bar', date: WED, from: '08:00', hours: 6 }),
      block({ project: 'bar', date: WED, from: '15:30', hours: 4 }),
      block({ project: 'bar', date: THU, from: '08:00', hours: 6 }),
      block({ project: 'bar', date: THU, from: '15:30', hours: 4 }),
      block({ project: 'bar', date: NEXT_MON, from: '08:00', hours: 6 }),
      block({ project: 'bar', date: NEXT_MON, from: '15:30', hours: 4 }),
    ],
    overrides: [CLOSED],
  });

  it('lays the hours out on the closed day itself, padlocked', () => {
    const result = plan(calendar, { startDate: NEXT_TUE, hours: 4 });

    expect(expectOk(result).decision.floorBinding).toBe(false);
    expect(rows(result)).toEqual([`${NEXT_TUE} 08:00-12:00 [locked]`]);
  });

  it('padlocks the closed day only: the tail is the engine\'s day', () => {
    const result = plan(calendar, { startDate: NEXT_TUE, hours: 14 });
    const placed = expectOk(result).placed;
    const onClosedDay = placed.filter((row) => row.date === NEXT_TUE);

    // Asserted as MINUTES, not with `every`: an empty day satisfies `every` vacuously, which is
    // how a version that places nothing there passes a test meant to prove that it does.
    expect(onClosedDay.reduce((total, row) => total + row.durationMinutes, 0)).toBe(10 * 60);
    expect(onClosedDay.every((row) => row.locked)).toBe(true);
    expect(placed.filter((row) => row.date !== NEXT_TUE).every((row) => !row.locked)).toBe(true);
    expect(placed.some((row) => row.date !== NEXT_TUE)).toBe(true);
    expect(minutesOf(result, 'new')).toBe(14 * 60);
  });

  it('never overlaps work already sitting on the closed day', () => {
    const withWork = input({
      blocks: [block({ project: 'bar', date: NEXT_TUE, from: '09:00', hours: 2, locked: true })],
      overrides: [CLOSED],
    });
    const result = plan(withWork, { startDate: NEXT_TUE, hours: 3 });

    expect(rows(result)).toEqual([`${NEXT_TUE} 11:00-14:00 [locked]`]);
  });

  it('skips a closed day when anchoring the tail of a chosen weekend day', () => {
    const closedMonday = input({
      overrides: [{ date: NEXT_MON, isClosed: true, capacityHours: null, note: 'Festivo' }],
    });
    const result = plan(closedMonday, { startDate: SAT, hours: 14 });
    const placed = expectOk(result).placed;
    const onSaturday = placed.filter((row) => row.date === SAT);

    expect(onSaturday.reduce((total, row) => total + row.durationMinutes, 0)).toBe(10 * 60);
    expect(onSaturday.every((row) => row.locked)).toBe(true);
    // The tail may not be anchored on the closed Monday: compose lays nothing out there.
    expect(placed.map((row) => row.date)).not.toContain(NEXT_MON);
    expect(minutesOf(result, 'new')).toBe(14 * 60);
  });
});

describe('what the plan hands the caller', () => {
  it('returns the whole calendar to compose, with the job in it', () => {
    const calendar = input({ blocks: [block({ project: 'bar', date: WED, from: '08:00', hours: 6 })] });
    const result = plan(calendar, { startDate: NEXT_TUE, hours: 4 });

    expect(expectOk(result).blocks).toHaveLength(2);
    expect(minutesOf(result, 'bar')).toBe(6 * 60);
    expect(minutesOf(result, 'new')).toBe(4 * 60);
  });

  it('refuses, rather than half-placing, when the hours run past the horizon', () => {
    const result = plan(input({}), { startDate: MON, hours: 4000 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.messageKey).toBe('errors.horizonExceeded');
  });

  it('names a locked row in the way, which forcing does not move', () => {
    const calendar = input({
      blocks: [
        block({ project: 'bar', date: WED, from: '08:00', hours: 2 }),
        block({ project: 'bar', date: NEXT_TUE, from: '10:00', hours: 2, locked: true }),
      ],
    });
    const result = plan(calendar, { startDate: NEXT_TUE, hours: 4 });
    const collisions = expectOk(result).collisions;

    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({ projectId: 'bar', date: NEXT_TUE, locked: true, fixed: true });
    // Fill and overflow: the hole in front of the lock is used, the lock untouched.
    expect(rows(result)).toEqual([`${NEXT_TUE} 08:00-10:00 [locked]`, `${NEXT_TUE} 12:00-14:00 [locked]`]);
  });

  it('lands the whole calendar on a fixed point: the second pass moves nothing', () => {
    // A plan that is not a fixed point reshapes the calendar on the next unrelated save.
    const calendar = input({
      blocks: [
        block({ project: 'bar', date: WED, from: '08:00', hours: 6 }),
        block({ project: 'bar', date: THU, from: '08:00', hours: 4 }),
      ],
      gaps: [gap({ date: NEXT_WED, from: '10:00', hours: 1 })],
    });

    for (const startDate of [WED, NEXT_TUE, FRI, SAT, LAST_WED]) {
      const result = plan(calendar, { startDate, hours: 14 });
      const first = compose({
        ...calendar,
        blocks: expectOk(result).blocks,
        newProjectIds: ['new'],
      });
      const second = compose({ ...calendar, blocks: reload(first) });

      expect(lines(second), `${startDate}: the second pass moved something`).toEqual(lines(first));
    }
  });

  it('never overlaps work already on a chosen weekend day', () => {
    const calendar = input({
      blocks: [block({ project: 'bar', date: SAT, from: '09:00', hours: 2, locked: true })],
    });
    const result = plan(calendar, { startDate: SAT, hours: 3 });

    // One free run holds it whole (11:00-14:00); the existing row keeps its slot.
    expect(rows(result)).toEqual([`${SAT} 11:00-14:00 [locked]`]);
  });

  it('honours a closed day, where the engine would place nothing at all', () => {
    const calendar = input({
      overrides: [{ date: NEXT_TUE, isClosed: true, capacityHours: null, note: 'Festivo' }],
    });
    const result = plan(calendar, { startDate: NEXT_TUE, hours: 4 });

    expect(expectOk(result).decision.day).toBe('closed');
    expect(rows(result)).toEqual([`${NEXT_TUE} 08:00-12:00 [locked]`]);
    expect(expectOk(result).decision.needsDayConfirmation).toBe(true);
  });
});
