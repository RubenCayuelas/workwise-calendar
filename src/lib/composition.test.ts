// The composition engine's specification. Every `describe` names one business rule, so a red
// test says which rule broke. The engine is PURE
// (`today` is an input), times are INTEGER MINUTES, and assertions are on rendered
// `YYYY-MM-DD HH:mm-HH:mm project` lines. The week is the wireframe's: 10-16 August 2026.

import { beforeEach, describe, expect, it } from 'vitest';
import { MINUTES_PER_DAY, compareDates, hhmmToMinutes as t, isWeekend, minutesToHHmm } from './dates';
import { DEFAULT_SETTINGS, dayShapeFromSettings } from './settings';
import { firstWorkingMinute, manualWindowsOf } from './manualWindow';
import { MIN_ROW_MINUTES } from './validation';
import type { Block, DayOverride, DayShape, Gap } from '../types';
import {
  buildQueue,
  changeProjectMinutes,
  compose,
  createDayConfigResolver,
  dayReflows,
  findGapConflicts,
  horizonEndDate,
  isMovable,
  plannableMinutes,
  resizeBlock,
  resolveManualPlacement,
  summarizeSchedule,
  type BlockResize,
  type ComposeInput,
  type ComposeResult,
  type ComposeSuccess,
  type EditResult,
  type EditSuccess,
  type FreedHoursChoice,
  type ManualPlacement,
  type ManualPlacementResult,
  type ManualPlacementSuccess,
  type PlacedBlock,
} from './composition';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LAST_FRI = '2026-08-07';
const MON = '2026-08-10';
const TUE = '2026-08-11';
const WED = '2026-08-12';
const THU = '2026-08-13';
const FRI = '2026-08-14';
const SAT = '2026-08-15';
const SUN = '2026-08-16';
const NEXT_MON = '2026-08-17';

/** A day with BOTH views derived as `dayShapeFromSettings` derives them, so they cannot disagree. */
function withWindows(spec: Omit<DayShape, 'manualWindows'>): DayShape {
  return {
    ...spec,
    manualWindows: manualWindowsOf(spec.periods, spec.marginTopMinutes, spec.marginBottomMinutes),
  };
}

/** The shop's split shift: 08:00-14:00, lunch, 15:30-19:30. Auto-fill stops at 10 h. */
const SHAPE: DayShape = withWindows({
  periods: [
    { startMinutes: t('08:00'), endMinutes: t('14:00') },
    { startMinutes: t('15:30'), endMinutes: t('19:30') },
  ],
  shiftMinutes: 600,
  capacityMinutes: 600,
  marginTopMinutes: 60,
  marginBottomMinutes: 60,
  timelineStartMinutes: t('07:00'),
  timelineEndMinutes: t('20:30'),
});

/** The same day with a shorter auto-fill stop line, so multi-day tests stay one row per day. */
function withCapacity(hours: number): DayShape {
  return { ...SHAPE, capacityMinutes: Math.round(hours * 60) };
}

let sequence = 0;
let tailSequence = 0;

beforeEach(() => {
  sequence = 0;
  tailSequence = 0;
});

/** Creation order, as a sortable timestamp. It is the queue's documented tiebreaker. */
function creationStamp(index: number): string {
  return new Date(Date.UTC(2026, 7, 1, 8, 0, 0) + index * 60_000).toISOString().slice(0, 19).replace('T', ' ');
}

interface BlockSpec {
  id?: string;
  project: string;
  date: string;
  /** `HH:mm`. Doubles as the block's queue rank — see `ComposeInput.blocks`. */
  from: string;
  hours: number;
  locked?: boolean;
  createdAt?: string;
}

function block(spec: BlockSpec): Block {
  const index = ++sequence;
  return {
    id: spec.id ?? `b${index}`,
    projectId: spec.project,
    date: spec.date,
    startMinutes: t(spec.from),
    durationMinutes: Math.round(spec.hours * 60),
    locked: spec.locked ?? false,
    createdAt: spec.createdAt ?? creationStamp(index),
    updatedAt: creationStamp(index),
  };
}

function gap(spec: { date: string; from: string; hours: number; reason?: string }): Gap {
  const index = ++sequence;
  return {
    id: `g${index}`,
    unitId: `g${index}`,
    date: spec.date,
    startMinutes: t(spec.from),
    durationMinutes: Math.round(spec.hours * 60),
    reason: spec.reason,
    createdAt: creationStamp(index),
    updatedAt: creationStamp(index),
  };
}

function closedDay(date: string, note = 'Festivo'): DayOverride {
  return { date, isClosed: true, capacityHours: null, note };
}

function dayCapacity(date: string, hours: number): DayOverride {
  return { date, isClosed: false, capacityHours: hours };
}

interface InputSpec {
  today: string;
  blocks?: Block[];
  gaps?: Gap[];
  shape?: DayShape;
  overrides?: DayOverride[];
  horizonWeeks?: number;
  newProjectIds?: string[];
  grownProjectIds?: string[];
}

function input(spec: InputSpec): ComposeInput {
  return {
    today: spec.today,
    blocks: spec.blocks ?? [],
    gaps: spec.gaps ?? [],
    getDayConfig: createDayConfigResolver(spec.shape ?? SHAPE, spec.overrides ?? []),
    planningHorizonWeeks: spec.horizonWeeks ?? DEFAULT_SETTINGS.planningHorizonWeeks,
    newProjectIds: spec.newProjectIds,
    grownProjectIds: spec.grownProjectIds,
  };
}

/**
 * A bottom-edge drag, with what a resize needs beyond the number the owner drew: the day in BOTH
 * views (the stretch is cut over its manual windows), an id factory and a clock for the row a
 * stretch across the lunch break grows. `shape` is passed only for a day that is not the shift.
 */
function resizing(
  spec: {
    blockId: string;
    durationMinutes: number;
    today: string;
    /** The owner's answer when the freed hours have nowhere to go. Absent means ask. */
    freedHours?: FreedHoursChoice;
  },
  shape: DayShape = SHAPE,
): BlockResize {
  return {
    ...spec,
    day: { periods: shape.periods, manualWindows: shape.manualWindows },
    newBlockId: () => `resize-${++tailSequence}`,
    now: '2026-08-12 09:00:00',
  };
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function expectOk(result: ComposeResult): ComposeSuccess {
  if (!result.ok) {
    throw new Error(`expected a placement, got the error "${result.error.code}"`);
  }
  return result;
}

function describeBlock(placed: PlacedBlock): string {
  const start = minutesToHHmm(placed.startMinutes);
  const end = minutesToHHmm(placed.startMinutes + placed.durationMinutes);
  return `${placed.date} ${start}-${end} ${placed.projectId}${placed.locked ? ' [locked]' : ''}`;
}

/** The recomposed calendar as readable rows, in the order the engine returned them. */
function rows(result: ComposeResult): string[] {
  return expectOk(result).blocks.map(describeBlock);
}

function minutesByProject(blocks: readonly { projectId: string; durationMinutes: number }[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const item of blocks) {
    totals[item.projectId] = (totals[item.projectId] ?? 0) + item.durationMinutes;
  }
  return totals;
}

/** The data-model invariant: the engine moves hours, it never creates or loses them. */
function expectMinutesConserved(composeInput: ComposeInput, result: ComposeResult): void {
  expect(minutesByProject(expectOk(result).blocks)).toEqual(minutesByProject(composeInput.blocks));
}

/** Feeds a placement back in, so the engine can be asked to recompose its own output. */
function reload(result: ComposeResult): Block[] {
  return expectOk(result).blocks.map((placed, index) => ({
    id: placed.id ?? `inserted-${index}`,
    projectId: placed.projectId,
    date: placed.date,
    durationMinutes: placed.durationMinutes,
    startMinutes: placed.startMinutes,
    locked: placed.locked,
    createdAt: creationStamp(index),
    updatedAt: creationStamp(index),
  }));
}

/**
 * Recomposing the engine's own output must be a no-op, and so must the NEXT save. An engine that is
 * not a fixed point reshapes the calendar on a save that had nothing to do with the rows that moved.
 */
function expectSettled(composeInput: ComposeInput, result: ComposeResult, where = 'the reflow'): void {
  const later = compose({
    ...composeInput,
    blocks: reload(result),
    newProjectIds: undefined,
    grownProjectIds: undefined,
  });
  expect(rows(later), `${where}: the second pass moved something`).toEqual(rows(result));
  expect(expectOk(later).deletedBlockIds, `${where}: the second pass deleted a row`).toEqual([]);
  expect(expectOk(later).blocks.every((placed) => placed.id !== null), `${where}: the second pass inserted a row`).toBe(
    true,
  );
}

/** The rows of one job, as `date HH:mm-HH:mm` lines, for the hour-editing tests. */
function jobRows(blocks: readonly Block[], projectId: string): string[] {
  return blocks
    .filter((block) => block.projectId === projectId)
    .sort((a, b) => a.date.localeCompare(b.date) || a.startMinutes - b.startMinutes)
    .map(
      (block) =>
        `${block.date} ${minutesToHHmm(block.startMinutes)}-${minutesToHHmm(
          block.startMinutes + block.durationMinutes,
        )}${block.locked ? ' [locked]' : ''}`,
    );
}

function expectEdited(result: EditResult): EditSuccess {
  if (!result.ok) throw new Error(`expected an edit, got the error "${result.error.code}"`);
  return result;
}

/** The rows the engine may not move, in queue order. */
function lockedIds(blocks: readonly (Block | PlacedBlock)[]): string[] {
  return blocks
    .filter((block) => block.locked)
    .map((block) => block.id ?? '')
    .sort();
}

function sortedIds(blocks: readonly Block[]): string[] {
  return [...blocks]
    .sort((a, b) => compareDates(a.date, b.date) || a.startMinutes - b.startMinutes)
    .map((block) => block.id);
}

/** A hand drop of `blockId`, with deterministic ids for the rows a displaced tail needs. */
function dropOf(blockId: string): ManualPlacement {
  return {
    blockId,
    now: '2026-08-15 09:00:00',
    newBlockId: () => `cola-${++tailSequence}`,
  };
}

function expectPlaced(result: ManualPlacementResult): ManualPlacementSuccess {
  if (!result.ok) throw new Error(`expected a placement, got the error "${result.error.code}"`);
  return result;
}

/**
 * Stored rows as readable calendar lines, in calendar order. The clock is printed where it is a
 * clock: a row a RESOLUTION produced may legitimately read `13:30 + 150 min` — on the reflowed side
 * a cut victim's tail is a queue RANK and `compose` is what lays it out.
 */
function calendarRows(blocks: readonly Block[]): string[] {
  const clock = (minutes: number): string =>
    minutes >= 0 && minutes <= MINUTES_PER_DAY ? minutesToHHmm(minutes) : String(minutes);
  return [...blocks]
    .sort((a, b) => compareDates(a.date, b.date) || a.startMinutes - b.startMinutes)
    .map(
      (row) =>
        `${row.date} ${clock(row.startMinutes)}-${clock(
          row.startMinutes + row.durationMinutes,
        )} ${row.projectId}${row.locked ? ' [locked]' : ''}`,
    );
}

/** A stored block is always a solid rectangle on the clock — never across lunch or the day's end. */
function expectInsideOneWorkingPeriod(placed: PlacedBlock, shape: DayShape = SHAPE): void {
  const end = placed.startMinutes + placed.durationMinutes;
  const fits = shape.periods.some(
    (period) => placed.startMinutes >= period.startMinutes && end <= period.endMinutes,
  );
  expect(fits, `${describeBlock(placed)} straddles a non-working interval`).toBe(true);
}

// ---------------------------------------------------------------------------
// The per-day configuration the engine reads everything through
// ---------------------------------------------------------------------------

describe('getDayConfig — global settings, then the weekday rule, then the overrides', () => {
  it('matches the day shape the Settings screen produces', () => {
    expect(dayShapeFromSettings(DEFAULT_SETTINGS)).toEqual(SHAPE);

    const getDayConfig = createDayConfigResolver(SHAPE);
    expect(getDayConfig(MON).periods).toEqual(SHAPE.periods);
    expect(getDayConfig(MON).capacityMinutes).toBe(600);
    expect(getDayConfig(MON).isClosed).toBe(false);
  });

  it('gives Monday to Thursday auto-fill, Friday the buffer role and the weekend none', () => {
    const getDayConfig = createDayConfigResolver(SHAPE);

    expect([MON, TUE, WED, THU].map((date) => getDayConfig(date).role)).toEqual([
      'auto',
      'auto',
      'auto',
      'auto',
    ]);
    expect(getDayConfig(FRI).role).toBe('buffer');
    expect(getDayConfig(SAT).role).toBe('manual');
    expect(getDayConfig(SUN).role).toBe('manual');
  });

  it('lets a day override close a day or replace its capacity, keeping the weekday role', () => {
    const getDayConfig = createDayConfigResolver(SHAPE, [closedDay(WED), dayCapacity(THU, 4)]);

    expect(getDayConfig(WED).isClosed).toBe(true);
    expect(getDayConfig(THU).capacityMinutes).toBe(240);
    expect(getDayConfig(THU).role).toBe('auto');
    expect(getDayConfig(TUE).capacityMinutes).toBe(600);
  });

  it('caps an override capacity at the shift: the stop line can shorten a day, never lengthen it', () => {
    // The stop line only ever fills LESS than the shift; it can never buy more hours than it covers.
    const getDayConfig = createDayConfigResolver(SHAPE, [dayCapacity(THU, 99)]);
    expect(getDayConfig(THU).capacityMinutes).toBe(600);
  });
});

// ---------------------------------------------------------------------------
// Rule 1 — Queue order
// ---------------------------------------------------------------------------

describe('rule 1 — the queue order is the calendar order', () => {
  it('orders the queue by date and start time, so a job appended after the last block goes last', () => {
    const composeInput = input({
      today: MON,
      blocks: [
        block({ project: 'barandilla', date: MON, from: '08:00', hours: 2 }),
        block({ project: 'escalera', date: MON, from: '10:00', hours: 2 }),
        block({ project: 'porton', date: TUE, from: '08:00', hours: 2 }),
        // A brand-new job: the caller writes it after the last block on the calendar.
        block({ project: 'nuevo', date: TUE, from: '10:00', hours: 3 }),
      ],
      newProjectIds: ['nuevo'],
    });

    expect(buildQueue(composeInput).map((item) => item.projectId)).toEqual([
      'barandilla',
      'escalera',
      'porton',
      'nuevo',
    ]);
    expect(buildQueue(composeInput).map((item) => item.durationMinutes)).toEqual([120, 120, 120, 180]);
    expect(buildQueue(composeInput).map((item) => item.isNew)).toEqual([false, false, false, true]);
  });

  it('treats consecutive blocks of one job as a single item, and a job split around another as two', () => {
    const grouped = input({
      today: MON,
      blocks: [
        block({ id: 'morning', project: 'escalera', date: MON, from: '08:00', hours: 2 }),
        block({ id: 'rest', project: 'escalera', date: MON, from: '10:00', hours: 2 }),
      ],
    });
    expect(buildQueue(grouped)).toEqual([
      {
        projectId: 'escalera',
        blockIds: ['morning', 'rest'],
        durationMinutes: 240,
        isNew: false,
        grown: false,
        originalDates: [MON],
      },
    ]);

    const separated = input({
      today: MON,
      blocks: [
        block({ project: 'escalera', date: MON, from: '08:00', hours: 2 }),
        block({ project: 'porton', date: MON, from: '10:00', hours: 1 }),
        block({ project: 'escalera', date: MON, from: '11:00', hours: 2 }),
      ],
    });
    expect(buildQueue(separated).map((item) => item.projectId)).toEqual(['escalera', 'porton', 'escalera']);
    expect(buildQueue(separated).map((item) => item.durationMinutes)).toEqual([120, 60, 120]);
  });

  it('breaks a tie on the same start with created_at, then id, so the order is always total', () => {
    // Two blocks can only share a minute while a provisional one is in flight. The rule keeps the
    // engine deterministic when it happens; the next test is the placement the UI should send.
    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'younger', project: 'nuevo', date: MON, from: '08:00', hours: 1, createdAt: '2026-08-09 12:00:00' }),
        block({ id: 'older', project: 'escalera', date: MON, from: '08:00', hours: 1, createdAt: '2026-08-01 12:00:00' }),
        block({ id: 'aaa', project: 'porton', date: MON, from: '09:00', hours: 1, createdAt: '2026-08-01 12:00:00' }),
        block({ id: 'zzz', project: 'puerta', date: MON, from: '09:00', hours: 1, createdAt: '2026-08-01 12:00:00' }),
      ],
    });

    expect(buildQueue(composeInput).map((item) => item.projectId)).toEqual([
      'escalera',
      'nuevo',
      'porton',
      'puerta',
    ]);
  });

  it('reorders the queue on a drop: B, A, C, A with D dropped after B becomes B, D, A, C, A', () => {
    const composeInput = input({
      today: MON,
      blocks: [
        block({ project: 'b', date: MON, from: '08:00', hours: 2 }),
        block({ project: 'a', date: MON, from: '10:00', hours: 2 }),
        block({ project: 'c', date: MON, from: '12:00', hours: 2 }),
        block({ project: 'a', date: MON, from: '15:30', hours: 2 }),
        // The drop: D lands inside B, which ranks it after B and before A.
        block({ project: 'd', date: MON, from: '09:00', hours: 2 }),
      ],
    });

    expect(buildQueue(composeInput).map((item) => item.projectId)).toEqual(['b', 'd', 'a', 'c', 'a']);

    // ...and the unlocked jobs shift to make room. D keeps the POSITION, not the 09:00 it was at.
    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${MON} 08:00-10:00 b`,
      `${MON} 10:00-12:00 d`,
      `${MON} 12:00-14:00 a`,
      `${MON} 15:30-17:30 c`,
      `${MON} 17:30-19:30 a`,
    ]);
    expectMinutesConserved(composeInput, result);
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — The movable pool
// ---------------------------------------------------------------------------

describe('rule 2 — the movable pool', () => {
  it('moves an unlocked weekday block dated today or later, Friday included', () => {
    expect(isMovable(block({ project: 'escalera', date: MON, from: '08:00', hours: 2 }), MON)).toBe(true);
    expect(isMovable(block({ project: 'escalera', date: THU, from: '08:00', hours: 2 }), MON)).toBe(true);
    expect(isMovable(block({ project: 'escalera', date: FRI, from: '08:00', hours: 2 }), MON)).toBe(true);
  });

  it('excludes a locked block', () => {
    expect(isMovable(block({ project: 'escalera', date: TUE, from: '08:00', hours: 2, locked: true }), MON)).toBe(false);
  });

  it('excludes a block dated before today', () => {
    expect(isMovable(block({ project: 'escalera', date: MON, from: '08:00', hours: 2 }), TUE)).toBe(false);
    expect(isMovable(block({ project: 'escalera', date: LAST_FRI, from: '08:00', hours: 2 }), MON)).toBe(false);
  });

  it('excludes Saturday and Sunday', () => {
    expect(isMovable(block({ project: 'escalera', date: SAT, from: '09:00', hours: 2 }), MON)).toBe(false);
    expect(isMovable(block({ project: 'escalera', date: SUN, from: '09:00', hours: 2 }), MON)).toBe(false);
  });

  it('excludes a padlocked Friday row — the mark a drop onto the buffer leaves', () => {
    expect(
      isMovable(block({ project: 'escalera', date: FRI, from: '09:00', hours: 2, locked: true }), MON),
    ).toBe(false);
  });

  it('returns every excluded block untouched and flows the movable one around them', () => {
    const composeInput = input({
      today: TUE,
      blocks: [
        block({ project: 'historial', date: LAST_FRI, from: '08:00', hours: 4 }),
        block({ project: 'barandilla', date: TUE, from: '10:00', hours: 4, locked: true }),
        block({ project: 'urgencia', date: SAT, from: '09:00', hours: 3 }),
        block({ project: 'escalera', date: TUE, from: '16:00', hours: 2 }),
      ],
    });

    // The head of the queue fits the hole in front of the locked block, so it uses it.
    expect(rows(compose(composeInput))).toEqual([
      `${LAST_FRI} 08:00-12:00 historial`,
      `${TUE} 08:00-10:00 escalera`,
      `${TUE} 10:00-14:00 barandilla [locked]`,
      `${SAT} 09:00-12:00 urgencia`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — Monday to Thursday auto-fill
// ---------------------------------------------------------------------------

describe('rule 3 — Monday to Thursday auto-fill', () => {
  it('fills the split shift, flows past a locked block and treats a gap as occupied time', () => {
    const composeInput = input({
      today: MON,
      blocks: [
        block({ project: 'primera', date: MON, from: '08:00', hours: 2 }),
        block({ project: 'barandilla', date: MON, from: '10:00', hours: 2, locked: true }),
        block({ project: 'escalera', date: MON, from: '13:00', hours: 3 }),
      ],
      gaps: [gap({ date: MON, from: '12:00', hours: 1, reason: 'Avería torno' })],
    });

    // 10 h of shift, 2 h locked and 1 h of gap taken out: 7 h left to plan.
    expect(plannableMinutes(composeInput, MON)).toBe(420);

    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${MON} 08:00-10:00 primera`,
      `${MON} 10:00-12:00 barandilla [locked]`,
      // Not a wall: the flexible work resumes after the lock and the gap, across lunch.
      `${MON} 13:00-14:00 escalera`,
      `${MON} 15:30-17:30 escalera`,
    ]);
    expectMinutesConserved(composeInput, result);
  });
});

// ---------------------------------------------------------------------------
// Rule 4 — Plannable hours
// ---------------------------------------------------------------------------

describe('rule 4 — plannable hours are a union of intervals', () => {
  it('subtracts gaps and locked blocks from the enabled periods', () => {
    expect(plannableMinutes(input({ today: MON }), MON)).toBe(600);

    const withObstacles = input({
      today: MON,
      blocks: [block({ project: 'barandilla', date: MON, from: '08:00', hours: 3, locked: true })],
      gaps: [gap({ date: MON, from: '15:30', hours: 2 })],
    });
    expect(plannableMinutes(withObstacles, MON)).toBe(600 - 180 - 120);
  });

  it('counts an overlapping gap and locked block once, not twice', () => {
    const overlapping = input({
      today: MON,
      blocks: [block({ project: 'barandilla', date: MON, from: '08:00', hours: 3, locked: true })],
      gaps: [gap({ date: MON, from: '10:00', hours: 2, reason: 'Revisión' })],
    });

    // The union is 08:00-12:00 — 4 h, not the 5 h a naive sum would report.
    expect(plannableMinutes(overlapping, MON)).toBe(360);
  });

  it('ignores the part of an obstacle that falls outside the working periods', () => {
    const acrossLunch = input({
      today: MON,
      gaps: [gap({ date: MON, from: '13:00', hours: 3, reason: 'Gestoría' })],
    });
    // 13:00-14:00 and 15:30-16:00 are working time; the lunch break in between is not.
    expect(plannableMinutes(acrossLunch, MON)).toBe(600 - 60 - 30);

    const insideLunch = input({ today: MON, gaps: [gap({ date: MON, from: '14:00', hours: 1.5 })] });
    expect(plannableMinutes(insideLunch, MON)).toBe(600);
  });

  it('is capped by the day capacity, and is zero where the engine may not write', () => {
    const short = input({ today: MON, shape: withCapacity(4) });
    expect(plannableMinutes(short, MON)).toBe(240);

    // The stop line binds while the obstacles still leave more room than it allows...
    const shortAndBlocked = input({
      today: MON,
      shape: withCapacity(4),
      blocks: [block({ project: 'barandilla', date: MON, from: '08:00', hours: 5, locked: true })],
    });
    expect(plannableMinutes(shortAndBlocked, MON)).toBe(240);

    // ...and the obstacles bind once they leave less than it.
    const shortAndFull = input({
      today: MON,
      shape: withCapacity(4),
      blocks: [
        block({ project: 'barandilla', date: MON, from: '08:00', hours: 6, locked: true }),
        block({ project: 'cita', date: MON, from: '15:30', hours: 2, locked: true }),
      ],
    });
    expect(plannableMinutes(shortAndFull, MON)).toBe(120);

    const composeInput = input({ today: TUE, overrides: [closedDay(WED)] });
    expect(plannableMinutes(composeInput, WED)).toBe(0);
    expect(plannableMinutes(composeInput, SAT)).toBe(0);
    expect(plannableMinutes(composeInput, SUN)).toBe(0);
    expect(plannableMinutes(composeInput, MON)).toBe(0);
  });

  it('measures an obstacle on the clock, so one that straddles lunch costs only its working part', () => {
    // Impossible under the data model, but a hand-edited row could look like it: gaps and blocks are
    // ONE occupancy set clipped to the periods, so 08:00-16:00 costs 6 h + 30 min, not 8 h.
    const straddling = input({
      today: MON,
      blocks: [block({ project: 'barandilla', date: MON, from: '08:00', hours: 8, locked: true })],
    });
    expect(plannableMinutes(straddling, MON)).toBe(600 - 360 - 30);
  });
});

// ---------------------------------------------------------------------------
// Rule 5 — Friday, the buffer
// ---------------------------------------------------------------------------

describe('rule 5 — Friday is a buffer, not a workday', () => {
  it('never targets Friday with a new job: the tail skips to the following Monday', () => {
    const composeInput = input({
      today: MON,
      shape: withCapacity(4),
      blocks: [block({ project: 'nuevo', date: MON, from: '08:00', hours: 20 })],
      newProjectIds: ['nuevo'],
    });

    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${MON} 08:00-12:00 nuevo`,
      `${TUE} 08:00-12:00 nuevo`,
      `${WED} 08:00-12:00 nuevo`,
      `${THU} 08:00-12:00 nuevo`,
      `${NEXT_MON} 08:00-12:00 nuevo`,
    ]);
    expect(rows(result).some((row) => row.startsWith(FRI))).toBe(false);
    expectMinutesConserved(composeInput, result);
  });

  it('lets work already on the calendar overflow onto Friday — that is what the buffer is for', () => {
    const composeInput = input({
      today: MON,
      shape: withCapacity(4),
      // The same 20 h, but grown on a job already scheduled — which the operation has to say out
      // loud, because growth is the ONLY thing the colchón absorbs.
      blocks: [block({ project: 'escalera', date: MON, from: '08:00', hours: 20 })],
      grownProjectIds: ['escalera'],
    });

    expect(rows(compose(composeInput))).toEqual([
      `${MON} 08:00-12:00 escalera`,
      `${TUE} 08:00-12:00 escalera`,
      `${WED} 08:00-12:00 escalera`,
      `${THU} 08:00-12:00 escalera`,
      `${FRI} 08:00-12:00 escalera`,
    ]);
  });

  it('pulls Friday work back when Monday to Thursday frees up, so the buffer self-cleans', () => {
    const composeInput = input({
      today: MON,
      blocks: [block({ project: 'porton', date: FRI, from: '08:00', hours: 4 })],
    });

    expect(rows(compose(composeInput))).toEqual([`${MON} 08:00-12:00 porton`]);
  });

  it('leaves Friday work alone when it is locked — the way to keep something there on purpose', () => {
    const composeInput = input({
      today: MON,
      blocks: [block({ project: 'porton', date: FRI, from: '08:00', hours: 4, locked: true })],
    });

    expect(rows(compose(composeInput))).toEqual([`${FRI} 08:00-12:00 porton [locked]`]);
  });

  it('carries what Friday cannot hold into next Monday, skipping the weekend', () => {
    const composeInput = input({
      today: MON,
      shape: withCapacity(4),
      blocks: [block({ project: 'escalera', date: MON, from: '08:00', hours: 24 })],
      grownProjectIds: ['escalera'],
    });

    expect(rows(compose(composeInput))).toEqual([
      `${MON} 08:00-12:00 escalera`,
      `${TUE} 08:00-12:00 escalera`,
      `${WED} 08:00-12:00 escalera`,
      `${THU} 08:00-12:00 escalera`,
      `${FRI} 08:00-12:00 escalera`,
      `${NEXT_MON} 08:00-12:00 escalera`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Rule 5 — the other half of the buffer: what a HUMAN put on Friday
// ---------------------------------------------------------------------------
//
// Friday is in the movable pool, so the reflow reaches Monday first and pulls a hand-dropped row
// straight back off the colchón unless something on the row says a human put it there.

describe('rule 5 — the engine only recovers from Friday what it put there itself', () => {
  it('leaves a padlocked Friday row exactly where it was dropped, week empty in front of it', () => {
    const composeInput = input({
      today: MON,
      blocks: [block({ id: 'a-mano', project: 'porton', date: FRI, from: '10:00', hours: 4, locked: true })],
    });

    const result = compose(composeInput);
    // It keeps the SLOT and not merely the day: on the buffer a drop padlocks the row.
    expect(rows(result)).toEqual([`${FRI} 10:00-14:00 porton [locked]`]);
    expect(lockedIds(expectOk(result).blocks)).toEqual(['a-mano']);
    expectSettled(composeInput, result);
  });

  it('still pulls back what the ENGINE put on Friday — the buffer self-cleans', () => {
    // The asymmetry, stated as itself: the same row without the padlock comes home.
    const composeInput = input({
      today: MON,
      blocks: [block({ project: 'porton', date: FRI, from: '10:00', hours: 4 })],
    });

    expect(rows(compose(composeInput))).toEqual([`${MON} 08:00-12:00 porton`]);
  });

  it('keeps it out of the movable pool, so the rest of the week flows around it', () => {
    expect(
      isMovable(block({ project: 'porton', date: FRI, from: '10:00', hours: 4, locked: true }), MON),
    ).toBe(false);

    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'a-mano', project: 'porton', date: FRI, from: '10:00', hours: 4, locked: true }),
        block({ id: 'nueva', project: 'escalera', date: NEXT_MON, from: '08:00', hours: 4 }),
      ],
      newProjectIds: ['escalera'],
    });

    // An obstacle rather than a queue item, so it does not drag the cursor to Friday.
    expect(buildQueue(composeInput).map((item) => item.blockIds)).toEqual([['nueva']]);
    const result = compose(composeInput);
    expect(rows(result)).toEqual([`${MON} 08:00-12:00 escalera`, `${FRI} 10:00-14:00 porton [locked]`]);
    expectSettled(composeInput, result);
  });

  it('costs Friday the hours it holds, like any other obstacle', () => {
    const composeInput = input({
      today: MON,
      blocks: [block({ project: 'porton', date: FRI, from: '10:00', hours: 4, locked: true })],
    });

    expect(plannableMinutes(composeInput, FRI)).toBe(6 * 60);
  });

  it('leaves the job\'s automatic hours entirely to the engine', () => {
    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'automatico', project: 'porton', date: THU, from: '08:00', hours: 6 }),
        block({ id: 'a-mano', project: 'porton', date: FRI, from: '10:00', hours: 4, locked: true }),
      ],
    });

    const result = compose(composeInput);
    expect(rows(result)).toEqual([`${MON} 08:00-14:00 porton`, `${FRI} 10:00-14:00 porton [locked]`]);
    expectSettled(composeInput, result);
  });

  it('is inert on the weekend and in the frozen past, which are outside the pool anyway', () => {
    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'sabado', project: 'urgencia', date: SAT, from: '10:00', hours: 2, locked: true }),
        block({ id: 'pasado', project: 'historial', date: LAST_FRI, from: '10:00', hours: 2, locked: true }),
      ],
    });

    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${LAST_FRI} 10:00-12:00 historial [locked]`,
      `${SAT} 10:00-12:00 urgencia [locked]`,
    ]);
    expect(lockedIds(expectOk(result).blocks)).toEqual(['pasado', 'sabado']);
  });
});

// ---------------------------------------------------------------------------
// Rule 6 — The weekend
// ---------------------------------------------------------------------------

describe('rule 6 — the weekend is outside the engine', () => {
  it('never auto-places anything on Saturday or Sunday', () => {
    const composeInput = input({
      today: MON,
      shape: withCapacity(4),
      blocks: [block({ project: 'escalera', date: MON, from: '08:00', hours: 24 })],
    });

    const weekend = expectOk(compose(composeInput)).blocks.filter(
      (placed) => placed.date === SAT || placed.date === SUN,
    );
    expect(weekend).toEqual([]);
  });

  it('never recovers a block a human put on Saturday, even with the whole week empty and no lock', () => {
    const composeInput = input({
      today: MON,
      blocks: [
        block({ project: 'urgencia', date: SAT, from: '10:00', hours: 4 }),
        block({ project: 'escalera', date: MON, from: '08:00', hours: 2 }),
      ],
    });

    expect(rows(compose(composeInput))).toEqual([
      `${MON} 08:00-10:00 escalera`,
      `${SAT} 10:00-14:00 urgencia`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Rule 7 — No backfilling
// ---------------------------------------------------------------------------

describe('rule 7 — no backfilling: the cursor never goes back', () => {
  // What the rule still forbids is the CURSOR: once the queue has walked past free minutes, nothing
  // comes back for them. "The hole in front of a locked block stays empty" is not part of it.

  it('fills the hour in front of a locked block and carries on after it', () => {
    // The prototype's scenario: a 4 h job, a 2 h lock at 09:00, a 1 h job, an 8 h stop line. The
    // 08:00-09:00 hour is an hour of the 4 h job, and its other three follow the lock.
    const composeInput = input({
      today: MON,
      shape: withCapacity(8),
      blocks: [
        block({ project: 'grande', date: MON, from: '08:00', hours: 4 }),
        block({ project: 'cita', date: MON, from: '09:00', hours: 2, locked: true }),
        block({ project: 'pequeno', date: MON, from: '11:00', hours: 1 }),
      ],
    });

    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${MON} 08:00-09:00 grande`,
      `${MON} 09:00-11:00 cita [locked]`,
      `${MON} 11:00-14:00 grande`,
      `${MON} 15:30-16:30 pequeno`,
    ]);
    expectMinutesConserved(composeInput, result);
    expectSettled(composeInput, result);
  });

  it('never comes back for the hours a day capacity left behind', () => {
    // The plainest surviving form: Monday's stop line is 8 h of a 10 h shift, so 17:30-19:30 is free
    // clock the engine has finished with and the 1 h job behind is on Tuesday, not in it.
    const composeInput = input({
      today: MON,
      shape: withCapacity(8),
      blocks: [
        block({ project: 'grande', date: MON, from: '08:00', hours: 8 }),
        block({ project: 'pequeno', date: MON, from: '19:00', hours: 1 }),
      ],
    });

    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${MON} 08:00-14:00 grande`,
      `${MON} 15:30-17:30 grande`,
      `${TUE} 08:00-09:00 pequeno`,
    ]);
    expectMinutesConserved(composeInput, result);
    expectSettled(composeInput, result);
  });

  it('steps over a stretch too short to be a row, and no later job may have it', () => {
    // A ten-minute hole cannot become a ten-minute row, so the 6 h job steps over it like a lock —
    // and the quarter-hour job behind it does not go back for it either.
    const composeInput = input({
      today: MON,
      blocks: [
        block({ project: 'cita', date: MON, from: '08:10', hours: 170 / 60, locked: true }),
        block({ project: 'grande', date: MON, from: '11:00', hours: 6 }),
        block({ project: 'pequeno', date: MON, from: '19:00', hours: 0.25 }),
      ],
    });

    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${MON} 08:10-11:00 cita [locked]`,
      `${MON} 11:00-14:00 grande`,
      `${MON} 15:30-18:30 grande`,
      `${MON} 18:30-18:45 pequeno`,
    ]);
    // Nothing at all was stored in the ten minutes before the lock.
    expect(expectOk(result).blocks.some((placed) => placed.startMinutes < t('08:10'))).toBe(false);
    expectMinutesConserved(composeInput, result);
    expectSettled(composeInput, result);
  });
});

// ---------------------------------------------------------------------------
// Rule 8 — Fill and overflow, always
// ---------------------------------------------------------------------------
//
// Work fills what is left of the day and the remainder overflows to the next day it can use,
// whoever placed it. A job may therefore end up in four or five pieces.

describe('rule 8 — a job fills what the day has left and the rest overflows', () => {
  it('fills the two hours left in the day and carries the remainder to the next', () => {
    const composeInput = input({
      today: MON,
      blocks: [
        block({ project: 'escalera', date: MON, from: '08:00', hours: 8 }),
        block({ project: 'porton', date: MON, from: '18:00', hours: 3 }),
      ],
    });

    // Monday has 2 h left after the staircase: the door takes them and finishes on Tuesday.
    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${MON} 08:00-14:00 escalera`,
      `${MON} 15:30-17:30 escalera`,
      `${MON} 17:30-19:30 porton`,
      `${TUE} 08:00-09:00 porton`,
    ]);
    expectMinutesConserved(composeInput, result);
    expectSettled(composeInput, result);
  });

  it('splits a job longer than a full day, and reuses ids for the segments it can', () => {
    const composeInput = input({
      today: MON,
      blocks: [block({ id: 'original', project: 'escalera', date: MON, from: '08:00', hours: 14 })],
    });

    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${MON} 08:00-14:00 escalera`,
      `${MON} 15:30-19:30 escalera`,
      `${TUE} 08:00-12:00 escalera`,
    ]);
    // The first segment keeps the row it came from; the rest are inserts.
    expect(expectOk(result).blocks.map((placed) => placed.id)).toEqual(['original', null, null]);
    expect(expectOk(result).deletedBlockIds).toEqual([]);
    expectMinutesConserved(composeInput, result);
  });

  it('starts a job that is longer than a day in the space left, not at the top of the next one', () => {
    const composeInput = input({
      today: MON,
      blocks: [
        block({ project: 'cita', date: MON, from: '08:00', hours: 4, locked: true }),
        block({ project: 'escalera', date: MON, from: '12:00', hours: 14 }),
      ],
    });

    expect(rows(compose(composeInput))).toEqual([
      `${MON} 08:00-12:00 cita [locked]`,
      `${MON} 12:00-14:00 escalera`,
      `${MON} 15:30-19:30 escalera`,
      `${TUE} 08:00-14:00 escalera`,
      `${TUE} 15:30-17:30 escalera`,
    ]);
  });

  it('uses the four hours a short day has left, and finishes on the next day', () => {
    // The owner's own case at the engine's level: a 5 h job and a Monday cut to 4 h of plannable
    // time is 4 h on Monday and 1 h on Tuesday.
    const composeInput = input({
      today: MON,
      blocks: [block({ project: 'escalera', date: MON, from: '15:30', hours: 5 })],
      gaps: [gap({ date: MON, from: '08:00', hours: 6, reason: 'Avería torno' })],
    });

    expect(plannableMinutes(composeInput, MON)).toBe(240);
    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${MON} 15:30-19:30 escalera`,
      `${TUE} 08:00-09:00 escalera`,
    ]);
    expectMinutesConserved(composeInput, result);
    expectSettled(composeInput, result);
  });

  it('splits into as many pieces as the week needs, which the owner accepted', () => {
    // Four days cut to two plannable hours each: a 7 h job comes out in four drawable pieces.
    const composeInput = input({
      today: MON,
      blocks: [block({ project: 'escalera', date: MON, from: '08:00', hours: 7 })],
      gaps: [MON, TUE, WED, THU].map((date) =>
        gap({ date, from: '10:00', hours: 9.5, reason: 'Feria' }),
      ),
    });

    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${MON} 08:00-10:00 escalera`,
      `${TUE} 08:00-10:00 escalera`,
      `${WED} 08:00-10:00 escalera`,
      `${THU} 08:00-09:00 escalera`,
    ]);
    expectMinutesConserved(composeInput, result);
    expectSettled(composeInput, result);
  });
});

// ---------------------------------------------------------------------------
// Rule 8 — a displaced tail, which needs no rule of its own any more
// ---------------------------------------------------------------------------
//
// A tail is ALREADY the remainder of work under way. It needed an exemption while a job that did
// not fit moved whole; now every item fills forward, so nothing is left to tell apart.

describe('rule 8 — a displaced tail fills forward like anything else', () => {
  const cutOnThursday = (): Block[] => [
    // Barandilla 12 h: Thursday full, the rest already on next Monday.
    block({ id: 'bar-am', project: 'barandilla', date: THU, from: '08:00', hours: 6 }),
    block({ id: 'bar-pm', project: 'barandilla', date: THU, from: '15:30', hours: 4 }),
    block({ id: 'bar-lunes', project: 'barandilla', date: NEXT_MON, from: '08:00', hours: 2 }),
    // Marquesina, just dropped at Thursday 10:00 — inside Barandilla's morning row.
    block({ id: 'marquesina', project: 'marquesina', date: THU, from: '10:00', hours: 2 }),
  ];

  it('keeps Thursday full after a drop cuts the job in two', () => {
    const composeInput = input({ today: THU, blocks: cutOnThursday() });
    const resolved = expectPlaced(resolveManualPlacement(composeInput, dropOf('marquesina')));

    const placement = compose({ ...composeInput, blocks: resolved.blocks });
    expect(rows(placement)).toEqual([
      `${THU} 08:00-10:00 barandilla`,
      `${THU} 10:00-12:00 marquesina`,
      // The tail used to jump WHOLE to next Monday, leaving 12:00-19:30 empty.
      `${THU} 12:00-14:00 barandilla`,
      `${THU} 15:30-19:30 barandilla`,
      `${NEXT_MON} 08:00-12:00 barandilla`,
    ]);
    expectMinutesConserved({ ...composeInput, blocks: resolved.blocks }, placement);
    expectSettled({ ...composeInput, blocks: resolved.blocks }, placement);
  });

  it('still skips the Friday colchon: a displaced tail is not growth', () => {
    const composeInput = input({ today: THU, blocks: cutOnThursday() });
    const resolved = expectPlaced(resolveManualPlacement(composeInput, dropOf('marquesina')));

    expect(rows(compose({ ...composeInput, blocks: resolved.blocks })).some((row) => row.startsWith(FRI))).toBe(
      false,
    );
  });

  it('fills the day the rest of a job reaches, rather than hunting for a whole day', () => {
    // After a resize the remainder used to leap past a day it could partly fill. Tuesday keeps only
    // its afternoon here, and the 4 h sized by hand are held by their PADLOCK: an obstacle.
    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'a-mano', project: 'escalera', date: MON, from: '08:00', hours: 4, locked: true }),
        block({ id: 'resto', project: 'escalera', date: MON, from: '15:30', hours: 8 }),
      ],
      gaps: [gap({ date: TUE, from: '08:00', hours: 6, reason: 'Avería torno' })],
    });

    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${MON} 08:00-12:00 escalera [locked]`,
      `${MON} 12:00-14:00 escalera`,
      `${MON} 15:30-19:30 escalera`,
      `${TUE} 15:30-17:30 escalera`,
    ]);
    expectMinutesConserved(composeInput, result);
    expectSettled(composeInput, result);
  });

  it('treats a job with ONE item exactly the same way — there is no first placement any more', () => {
    // A single-item job on a Monday holding 4 h fills those four hours and finishes on Tuesday —
    // the same answer its own tail would have got.
    const composeInput = input({
      today: MON,
      blocks: [block({ id: 'sola', project: 'escalera', date: MON, from: '15:30', hours: 5 })],
      gaps: [gap({ date: MON, from: '08:00', hours: 6, reason: 'Avería torno' })],
    });

    expect(buildQueue(composeInput)).toHaveLength(1);
    expect(rows(compose(composeInput))).toEqual([
      `${MON} 15:30-19:30 escalera`,
      `${TUE} 08:00-09:00 escalera`,
    ]);
  });

  it('carries no flag telling a job\'s later items from its first', () => {
    // The queue is the same three items it always was, and nothing on them says which is a remainder.
    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'primera', project: 'escalera', date: MON, from: '08:00', hours: 2 }),
        block({ id: 'otra', project: 'porton', date: MON, from: '10:00', hours: 1 }),
        block({ id: 'cola', project: 'escalera', date: MON, from: '11:00', hours: 2 }),
      ],
    });

    expect(buildQueue(composeInput).map((item) => item.projectId)).toEqual([
      'escalera',
      'porton',
      'escalera',
    ]);
    expect(Object.keys(buildQueue(composeInput)[0]).includes('continuation')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule 9 — Strict order (the prototype's one broken behaviour)
// ---------------------------------------------------------------------------

describe('rule 9 — strict order end to end', () => {
  it('sends the rest of the queue after a job that overflows, and never past it', () => {
    // A Tuesday with 5 h free behind a lock, the queue a 6 h staircase then a 2 h door: the staircase
    // takes the 5 h, its last hour goes to Wednesday, and the door follows it there.
    //
    // THE PROTOTYPE GETS THIS WRONG — it keeps filling the day after an item overflows, so the door
    // would take 13:00-14:00 + 15:30-16:30 and put a newer job ahead of an older one.
    const composeInput = input({
      today: TUE,
      blocks: [
        block({ project: 'barandilla', date: TUE, from: '08:00', hours: 5, locked: true }),
        block({ project: 'escalera', date: TUE, from: '13:00', hours: 6 }),
        block({ project: 'porton', date: TUE, from: '19:00', hours: 2 }),
      ],
    });

    expect(plannableMinutes(composeInput, TUE)).toBe(300);

    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${TUE} 08:00-13:00 barandilla [locked]`,
      `${TUE} 13:00-14:00 escalera`,
      `${TUE} 15:30-19:30 escalera`,
      `${WED} 08:00-09:00 escalera`,
      `${WED} 09:00-11:00 porton`,
    ]);
    // The door never got in front of the staircase, on either day.
    expect(
      rows(result)
        .filter((row) => !row.includes('barandilla'))
        .map((row) => row.split(' ')[2]),
    ).toEqual(['escalera', 'escalera', 'escalera', 'porton']);
    expectMinutesConserved(composeInput, result);
    expectSettled(composeInput, result);
  });

  it('never brings a later job forward into the space an overflowing one left', () => {
    // The prototype behaviour that must NOT be ported: X 3 h, Y 6 h, Z 2 h at an 8 h stop line. It places X
    // and Z and overflows Y; here Y takes what Monday has left, spills, and Z follows it.
    const composeInput = input({
      today: MON,
      shape: withCapacity(8),
      blocks: [
        block({ project: 'x', date: MON, from: '08:00', hours: 3 }),
        block({ project: 'y', date: MON, from: '11:00', hours: 6 }),
        block({ project: 'z', date: MON, from: '17:00', hours: 2 }),
      ],
    });

    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${MON} 08:00-11:00 x`,
      `${MON} 11:00-14:00 y`,
      `${MON} 15:30-17:30 y`,
      `${TUE} 08:00-09:00 y`,
      `${TUE} 09:00-11:00 z`,
    ]);
    expectMinutesConserved(composeInput, result);
    expectSettled(composeInput, result);
  });
});

// ---------------------------------------------------------------------------
// Rule 10 — The past is frozen
// ---------------------------------------------------------------------------

describe('rule 10 — the past is frozen', () => {
  it('never writes to a date earlier than today, and never closes a hole in it', () => {
    const composeInput = input({
      today: WED,
      blocks: [
        // A Monday cut short by a breakdown: the empty morning must stay empty.
        block({ id: 'ayer', project: 'historial', date: MON, from: '15:30', hours: 2 }),
        block({ project: 'escalera', date: WED, from: '10:00', hours: 3 }),
      ],
    });

    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${MON} 15:30-17:30 historial`,
      `${WED} 08:00-11:00 escalera`,
    ]);
    expect(expectOk(result).blocks.filter((placed) => placed.date < WED)).toEqual([
      {
        id: 'ayer',
        projectId: 'historial',
        date: MON,
        startMinutes: t('15:30'),
        durationMinutes: 120,
        locked: false,
      },
    ]);
  });

  it('replans today, unless the block that has already been started is locked', () => {
    const replanned = input({
      today: WED,
      blocks: [block({ project: 'escalera', date: WED, from: '17:00', hours: 2 })],
    });
    expect(rows(compose(replanned))).toEqual([`${WED} 08:00-10:00 escalera`]);

    const started = input({
      today: WED,
      blocks: [block({ project: 'escalera', date: WED, from: '17:00', hours: 2, locked: true })],
    });
    expect(rows(compose(started))).toEqual([`${WED} 17:00-19:00 escalera [locked]`]);
  });
});

// ---------------------------------------------------------------------------
// Rule 11 — Segments
// ---------------------------------------------------------------------------

describe('rule 11 — a segment never straddles a non-working interval', () => {
  it('stores a 3 h stretch starting at 13:00 as 13:00-14:00 plus 15:30-17:30', () => {
    const composeInput = input({
      today: MON,
      blocks: [
        block({ project: 'cita', date: MON, from: '08:00', hours: 5, locked: true }),
        block({ project: 'escalera', date: MON, from: '13:00', hours: 3 }),
      ],
    });

    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${MON} 08:00-13:00 cita [locked]`,
      `${MON} 13:00-14:00 escalera`,
      `${MON} 15:30-17:30 escalera`,
    ]);

    // Two blocks of one job, and the durations are net working hours: no lunch in either.
    const segments = expectOk(result).blocks.filter((placed) => placed.projectId === 'escalera');
    expect(segments).toHaveLength(2);
    expect(segments.map((placed) => placed.durationMinutes)).toEqual([60, 120]);
    for (const placed of expectOk(result).blocks) expectInsideOneWorkingPeriod(placed);
  });
});

// ---------------------------------------------------------------------------
// Rule 12 — Auto-merge
// ---------------------------------------------------------------------------

describe('rule 12 — auto-merge', () => {
  it('joins two blocks of the same job that touch inside one period, deleting the row it absorbed', () => {
    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'first', project: 'escalera', date: MON, from: '08:00', hours: 2 }),
        block({ id: 'second', project: 'escalera', date: MON, from: '10:00', hours: 2 }),
      ],
    });

    const result = compose(composeInput);
    expect(rows(result)).toEqual([`${MON} 08:00-12:00 escalera`]);
    expect(expectOk(result).blocks[0].id).toBe('first');
    expect(expectOk(result).deletedBlockIds).toEqual(['second']);
    expectMinutesConserved(composeInput, result);
  });

  it('keeps the two halves around lunch as two rows', () => {
    const composeInput = input({
      today: MON,
      blocks: [
        block({ project: 'cita', date: MON, from: '08:00', hours: 5, locked: true }),
        block({ project: 'escalera', date: MON, from: '13:00', hours: 3 }),
      ],
    });

    expect(rows(compose(composeInput)).filter((row) => row.includes('escalera'))).toHaveLength(2);
  });

  it('never merges across jobs, nor a locked block into an unlocked one', () => {
    const twoJobs = input({
      today: MON,
      blocks: [
        block({ project: 'escalera', date: MON, from: '08:00', hours: 2 }),
        block({ project: 'porton', date: MON, from: '10:00', hours: 2 }),
      ],
    });
    expect(rows(compose(twoJobs))).toEqual([
      `${MON} 08:00-10:00 escalera`,
      `${MON} 10:00-12:00 porton`,
    ]);

    const halfLocked = input({
      today: MON,
      blocks: [
        block({ project: 'escalera', date: MON, from: '08:00', hours: 2, locked: true }),
        block({ project: 'escalera', date: MON, from: '11:00', hours: 2 }),
      ],
    });
    expect(rows(compose(halfLocked))).toEqual([
      `${MON} 08:00-10:00 escalera [locked]`,
      `${MON} 10:00-12:00 escalera`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Rule 13 — The planning horizon
// ---------------------------------------------------------------------------

describe('rule 12 — auto-merge when two runs of one job meet after the reflow', () => {
  it('merges them: the block that ranked them apart is no longer between them', () => {
    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'viernes', project: 'escalera', date: FRI, from: '08:00', hours: 2 }),
        // A fixed block ranking between the two halves is skipped without breaking the run, so the
        // halves are ONE item. The alternative drifts — see "recomposing twice".
        block({ project: 'urgencia', date: SAT, from: '09:00', hours: 2 }),
        block({ id: 'siguiente', project: 'escalera', date: NEXT_MON, from: '08:00', hours: 2 }),
      ],
    });

    expect(buildQueue(composeInput).map((item) => item.projectId)).toEqual(['escalera']);
    expect(buildQueue(composeInput)[0].blockIds).toEqual(['viernes', 'siguiente']);

    // Both halves come back to Monday, and two touching rows of one job in one period are one row.
    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${MON} 08:00-12:00 escalera`,
      `${SAT} 09:00-11:00 urgencia`,
    ]);
    expect(expectOk(result).blocks[0].id).toBe('viernes');
    expect(expectOk(result).deletedBlockIds).toEqual(['siguiente']);
    expectMinutesConserved(composeInput, result);
  });

  it('does the same when a locked block later in the week is what ranked them apart', () => {
    const composeInput = input({
      today: MON,
      blocks: [
        block({ project: 'escalera', date: MON, from: '08:00', hours: 1 }),
        block({ project: 'cita', date: FRI, from: '10:00', hours: 2, locked: true }),
        block({ project: 'escalera', date: NEXT_MON, from: '08:00', hours: 2 }),
      ],
    });

    expect(rows(compose(composeInput))).toEqual([
      `${MON} 08:00-11:00 escalera`,
      `${FRI} 10:00-12:00 cita [locked]`,
    ]);
  });

  it('never merges what a human left on the weekend, even when two rows of one job touch', () => {
    // The weekend is never auto-recovered, so it is never auto-tidied either.
    const composeInput = input({
      today: MON,
      blocks: [
        block({ project: 'urgencia', date: SAT, from: '09:00', hours: 2 }),
        block({ project: 'urgencia', date: SAT, from: '11:00', hours: 2 }),
      ],
    });

    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${SAT} 09:00-11:00 urgencia`,
      `${SAT} 11:00-13:00 urgencia`,
    ]);
    expect(expectOk(result).deletedBlockIds).toEqual([]);
  });

  it('emits one solid row when the shift has no lunch break to split it at', () => {
    // With `period2Start === period1End` there is no interval to cut at: one rectangle.
    const noLunch: DayShape = withWindows({
      periods: [
        { startMinutes: t('08:00'), endMinutes: t('14:00') },
        { startMinutes: t('14:00'), endMinutes: t('18:00') },
      ],
      shiftMinutes: 600,
      capacityMinutes: 600,
      marginTopMinutes: 60,
      marginBottomMinutes: 60,
      timelineStartMinutes: t('07:00'),
      timelineEndMinutes: t('19:00'),
    });

    const composeInput = input({
      today: MON,
      shape: noLunch,
      blocks: [block({ project: 'escalera', date: MON, from: '08:00', hours: 8 })],
    });

    expect(rows(compose(composeInput))).toEqual([`${MON} 08:00-16:00 escalera`]);
  });
});

describe('rule 13 — the planning horizon', () => {
  it('reaches whole weeks from today', () => {
    expect(horizonEndDate(MON, 1)).toBe(SUN);
    expect(horizonEndDate(MON, 8)).toBe('2026-10-04');
  });

  it('fails cleanly, with no partial placement, when the hours do not fit', () => {
    const composeInput = input({
      today: MON,
      shape: withCapacity(4),
      horizonWeeks: 1,
      // 24 h against 5 fillable days of 4 h: 4 h have nowhere to go. The job grew,
      // so Friday counts as one of the five.
      blocks: [block({ project: 'escalera', date: MON, from: '08:00', hours: 24 })],
      grownProjectIds: ['escalera'],
    });

    const result = compose(composeInput);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('the horizon must be enforced');

    expect(result.error.code).toBe('horizon-exceeded');
    expect(result.error.projectId).toBe('escalera');
    expect(result.error.unplacedMinutes).toBe(240);
    expect(result.error.horizonEndDate).toBe(SUN);
    // An i18n key, never a sentence: the UI owns the wording.
    expect(result.error.messageKey).toMatch(/^[a-zA-Z][\w.]*$/);
    // Nothing to roll back by hand — a failure carries no placement at all.
    expect('blocks' in result).toBe(false);
  });

  it('places the same hours once the horizon is wide enough', () => {
    const composeInput = input({
      today: MON,
      shape: withCapacity(4),
      horizonWeeks: 2,
      blocks: [block({ project: 'escalera', date: MON, from: '08:00', hours: 24 })],
      grownProjectIds: ['escalera'],
    });

    expect(rows(compose(composeInput))).toEqual([
      `${MON} 08:00-12:00 escalera`,
      `${TUE} 08:00-12:00 escalera`,
      `${WED} 08:00-12:00 escalera`,
      `${THU} 08:00-12:00 escalera`,
      `${FRI} 08:00-12:00 escalera`,
      `${NEXT_MON} 08:00-12:00 escalera`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Rule 14 — Whole-day exceptions
// ---------------------------------------------------------------------------

describe('rule 14 — day overrides', () => {
  it('gives a closed day no plannable time and steps over it', () => {
    const composeInput = input({
      today: MON,
      overrides: [closedDay(WED, 'Puente de agosto')],
      blocks: [block({ project: 'escalera', date: MON, from: '08:00', hours: 24 })],
    });

    expect(plannableMinutes(composeInput, WED)).toBe(0);
    expect(rows(compose(composeInput))).toEqual([
      `${MON} 08:00-14:00 escalera`,
      `${MON} 15:30-19:30 escalera`,
      `${TUE} 08:00-14:00 escalera`,
      `${TUE} 15:30-19:30 escalera`,
      `${THU} 08:00-12:00 escalera`,
    ]);
  });

  it('moves unlocked work off a day that has just been closed', () => {
    const composeInput = input({
      today: MON,
      overrides: [closedDay(WED)],
      blocks: [block({ project: 'porton', date: WED, from: '08:00', hours: 4 })],
    });

    expect(rows(compose(composeInput))).toEqual([`${MON} 08:00-12:00 porton`]);
  });

  it('lets a day override replace the global capacity, and its overflow still skips the buffer', () => {
    const composeInput = input({
      today: THU,
      overrides: [dayCapacity(THU, 4)],
      blocks: [
        block({ project: 'escalera', date: THU, from: '08:00', hours: 4 }),
        block({ project: 'porton', date: THU, from: '13:00', hours: 2 }),
      ],
    });

    expect(plannableMinutes(composeInput, THU)).toBe(240);
      // Without the override both jobs sit on Thursday. Shortening a day is not GROWTH, and the
      // colchón is for growth alone, so the door skips Friday and waits for Monday.
    expect(rows(compose(composeInput))).toEqual([
      `${THU} 08:00-12:00 escalera`,
      `${NEXT_MON} 08:00-10:00 porton`,
    ]);

    // Say the door is what grew, and the buffer is exactly what absorbs it.
    expect(rows(compose({ ...composeInput, grownProjectIds: ['porton'] }))).toEqual([
      `${THU} 08:00-12:00 escalera`,
      `${FRI} 08:00-10:00 porton`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Rule 15 — The hours invariant
// ---------------------------------------------------------------------------

describe('rule 15 — the hours invariant', () => {
  it('gives every job back exactly the minutes it came in with', () => {
    // What each job's projects.total_hours says, in minutes.
    const totals = { escalera: 11 * 60, barandilla: 4 * 60, porton: 10 * 60, historial: 6 * 60 };

    const composeInput = input({
      today: TUE,
      blocks: [
        block({ project: 'historial', date: LAST_FRI, from: '08:00', hours: 6 }),
        block({ project: 'barandilla', date: TUE, from: '08:00', hours: 4, locked: true }),
        block({ project: 'escalera', date: TUE, from: '13:00', hours: 3 }),
        block({ project: 'escalera', date: WED, from: '08:00', hours: 8 }),
        block({ project: 'porton', date: WED, from: '17:00', hours: 10 }),
      ],
      gaps: [gap({ date: TUE, from: '12:00', hours: 1, reason: 'Avería torno' })],
    });

    expect(minutesByProject(composeInput.blocks)).toEqual(totals);

    const result = compose(composeInput);
    expect(minutesByProject(expectOk(result).blocks)).toEqual(totals);
    for (const placed of expectOk(result).blocks) {
      expect(placed.durationMinutes).toBeGreaterThan(0);
      expect(Number.isInteger(placed.durationMinutes)).toBe(true);
      expect(Number.isInteger(placed.startMinutes)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The prototype scenarios, ported
// ---------------------------------------------------------------------------

describe('recompose-poc.js scenario 1 — a job that does not fit spills onto the next day', () => {
  it('places A and B and spills C over the stop line (CHANGED, 2026-08-17)', () => {
    // The prototype pushed C whole to Tuesday. C takes the 3 h Monday's stop line has left and its
    // last hour is Tuesday's.
    const composeInput = input({
      today: MON,
      shape: withCapacity(8),
      blocks: [
        block({ project: 'a', date: MON, from: '08:00', hours: 3 }),
        block({ project: 'b', date: MON, from: '11:00', hours: 2 }),
        block({ project: 'c', date: MON, from: '13:00', hours: 4 }),
      ],
    });

    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${MON} 08:00-11:00 a`,
      `${MON} 11:00-13:00 b`,
      `${MON} 13:00-14:00 c`,
      `${MON} 15:30-17:30 c`,
      `${TUE} 08:00-09:00 c`,
    ]);
    expectMinutesConserved(composeInput, result);
    expectSettled(composeInput, result);
  });

  it('fits all three once the stop line is raised to 9 h (KEPT from the prototype)', () => {
    const composeInput = input({
      today: MON,
      shape: withCapacity(9),
      blocks: [
        block({ project: 'a', date: MON, from: '08:00', hours: 3 }),
        block({ project: 'b', date: MON, from: '11:00', hours: 2 }),
        block({ project: 'c', date: MON, from: '13:00', hours: 4 }),
      ],
    });

    expect(rows(compose(composeInput))).toEqual([
      `${MON} 08:00-11:00 a`,
      `${MON} 11:00-13:00 b`,
      `${MON} 13:00-14:00 c`,
      `${MON} 15:30-18:30 c`,
    ]);
  });

  // The prototype's third property — it keeps filling the day after an item overflows — is the one
  // deliberately CHANGED behaviour. Its regression test is "rule 9 — never brings a later job forward".
});

describe('recompose-poc.js scenario 2 — a locked block is not a wall', () => {
  it('carries the flexible work past the locked block instead of stopping at it (KEPT)', () => {
    // The prototype had no real clock, so it placed both flexible jobs before the locked one. What is
    // kept is the property: flexible work resumes after a lock rather than stopping at it.
    const composeInput = input({
      today: MON,
      blocks: [
        block({ project: 'd', date: MON, from: '08:00', hours: 3 }),
        block({ project: 'cliente', date: MON, from: '11:00', hours: 2, locked: true }),
        block({ project: 'f', date: MON, from: '13:00', hours: 3 }),
      ],
    });

    expect(rows(compose(composeInput))).toEqual([
      `${MON} 08:00-11:00 d`,
      `${MON} 11:00-13:00 cliente [locked]`,
      `${MON} 13:00-14:00 f`,
      `${MON} 15:30-17:30 f`,
    ]);
  });
});

describe('recompose-poc.js scenario 3 — one job split by hand around another', () => {
  it('needs no special case: the two halves are ordinary rows of the same project (KEPT)', () => {
    const composeInput = input({
      today: MON,
      blocks: [
        block({ project: 'escalera', date: MON, from: '08:00', hours: 2, locked: true }),
        block({ project: 'porton', date: MON, from: '10:00', hours: 3, locked: true }),
        block({ project: 'escalera', date: MON, from: '13:00', hours: 1, locked: true }),
        block({ project: 'nueva', date: MON, from: '15:30', hours: 2 }),
      ],
    });

    // Only the flexible job is in the queue; the three locked rows are obstacles.
    expect(buildQueue(composeInput).map((item) => item.projectId)).toEqual(['nueva']);
    expect(plannableMinutes(composeInput, MON)).toBe(240);

    // The two halves stay two rows: they do not touch, so auto-merge has nothing to do.
    expect(rows(compose(composeInput))).toEqual([
      `${MON} 08:00-10:00 escalera [locked]`,
      `${MON} 10:00-13:00 porton [locked]`,
      `${MON} 13:00-14:00 escalera [locked]`,
      `${MON} 15:30-17:30 nueva`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

describe('the engine is a pure function over a snapshot', () => {
  const busy = (): ComposeInput =>
    input({
      today: MON,
      blocks: [
        block({ project: 'primera', date: MON, from: '08:00', hours: 2 }),
        block({ project: 'barandilla', date: MON, from: '10:00', hours: 2, locked: true }),
        block({ project: 'escalera', date: MON, from: '13:00', hours: 3 }),
        block({ project: 'porton', date: TUE, from: '08:00', hours: 12 }),
      ],
      gaps: [gap({ date: MON, from: '12:00', hours: 1, reason: 'Avería torno' })],
    });

  it('returns the same placement for the same input, and leaves the input untouched', () => {
    const composeInput = busy();
    const snapshot = JSON.stringify(composeInput.blocks);

    expect(rows(compose(composeInput))).toEqual(rows(compose(composeInput)));
    expect(JSON.stringify(composeInput.blocks)).toBe(snapshot);
  });

  it('leaves an already tidy calendar alone: nothing to insert, nothing to delete', () => {
    const first = compose(busy());
    const settled = input({
      today: MON,
      blocks: reload(first),
      gaps: [gap({ date: MON, from: '12:00', hours: 1, reason: 'Avería torno' })],
    });

    const second = compose(settled);
    expect(rows(second)).toEqual(rows(first));
    expect(expectOk(second).deletedBlockIds).toEqual([]);
    expect(expectOk(second).blocks.every((placed) => placed.id !== null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Where two rules meet — which is where an engine that complies rule by rule comes apart
// ---------------------------------------------------------------------------

describe('rules 5 + 9 — the Friday buffer under strict order', () => {
  it('skips Friday for a new job even when Monday to Thursday are full and Friday is empty', () => {
    // The asymmetry at its sharpest: 16 h fills Mon-Thu at a 4 h stop line, Friday is completely
    // free, and the new 2 h job still waits for next Monday.
    const composeInput = input({
      today: MON,
      shape: withCapacity(4),
      blocks: [
        block({ project: 'escalera', date: MON, from: '08:00', hours: 16 }),
        block({ project: 'nuevo', date: MON, from: '13:00', hours: 2 }),
      ],
      newProjectIds: ['nuevo'],
    });

    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${MON} 08:00-12:00 escalera`,
      `${TUE} 08:00-12:00 escalera`,
      `${WED} 08:00-12:00 escalera`,
      `${THU} 08:00-12:00 escalera`,
      `${NEXT_MON} 08:00-10:00 nuevo`,
    ]);
    expectMinutesConserved(composeInput, result);
  });

  it('lets grown work take Friday and still sends the new job that follows it to next Monday', () => {
    const composeInput = input({
      today: MON,
      shape: withCapacity(4),
      blocks: [
        block({ project: 'escalera', date: MON, from: '08:00', hours: 20 }),
        block({ project: 'nuevo', date: MON, from: '13:00', hours: 2 }),
      ],
      newProjectIds: ['nuevo'],
      grownProjectIds: ['escalera'],
    });

    expect(rows(compose(composeInput))).toEqual([
      `${MON} 08:00-12:00 escalera`,
      `${TUE} 08:00-12:00 escalera`,
      `${WED} 08:00-12:00 escalera`,
      `${THU} 08:00-12:00 escalera`,
      `${FRI} 08:00-12:00 escalera`,
      `${NEXT_MON} 08:00-10:00 nuevo`,
    ]);
  });

  it('sends a new job created on a Friday to next Monday, since new work never targets the buffer', () => {
    // The rule is about the WEEKDAY and not about overflow, so it applies on the day itself too.
    const composeInput = input({
      today: FRI,
      blocks: [block({ project: 'nuevo', date: FRI, from: '08:00', hours: 3 })],
      newProjectIds: ['nuevo'],
    });

    expect(rows(compose(composeInput))).toEqual([`${NEXT_MON} 08:00-11:00 nuevo`]);
  });

  it('reports the horizon failure for a new job without ever counting Friday as room', () => {
    const composeInput = input({
      today: MON,
      shape: withCapacity(4),
      horizonWeeks: 1,
      // 20 h against Mon-Thu only: 16 h fit, and Friday's 4 h are not available
      // to a new job, so 4 h have nowhere to go inside the week.
      blocks: [block({ project: 'nuevo', date: MON, from: '08:00', hours: 20 })],
      newProjectIds: ['nuevo'],
    });

    const result = compose(composeInput);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('a new job must not be given the buffer');
    expect(result.error.projectId).toBe('nuevo');
    expect(result.error.unplacedMinutes).toBe(240);
    expect(result.error.horizonEndDate).toBe(SUN);
  });
});

describe('rules 5 + 3 — a locked block on the Friday buffer', () => {
  const overrun = (): ComposeInput =>
    input({
      today: MON,
      blocks: [
        // 46 h: 40 h fill Mon-Thu, and the 6 h that are left have to fit around
        // an appointment locked into the middle of Friday morning.
        block({ project: 'escalera', date: MON, from: '08:00', hours: 46 }),
        block({ project: 'cita', date: FRI, from: '09:00', hours: 4, locked: true }),
      ],
      grownProjectIds: ['escalera'],
    });

  it('flows the overflow around it, using the hour in front of it and resuming after it', () => {
    const composeInput = overrun();
    expect(plannableMinutes(composeInput, FRI)).toBe(360);

    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${MON} 08:00-14:00 escalera`,
      `${MON} 15:30-19:30 escalera`,
      `${TUE} 08:00-14:00 escalera`,
      `${TUE} 15:30-19:30 escalera`,
      `${WED} 08:00-14:00 escalera`,
      `${WED} 15:30-19:30 escalera`,
      `${THU} 08:00-14:00 escalera`,
      `${THU} 15:30-19:30 escalera`,
      // Longer than any day, so it fills the hour in front of the lock instead of leaving it.
      `${FRI} 08:00-09:00 escalera`,
      `${FRI} 09:00-13:00 cita [locked]`,
      `${FRI} 13:00-14:00 escalera`,
      `${FRI} 15:30-19:30 escalera`,
    ]);
    expectMinutesConserved(composeInput, result);
    for (const placed of expectOk(result).blocks) expectInsideOneWorkingPeriod(placed);
  });

  it('settles: recomposing that calendar changes nothing, inserts nothing and deletes nothing', () => {
    const first = compose(overrun());
    const second = compose(input({ today: MON, blocks: reload(first) }));

    expect(rows(second)).toEqual(rows(first));
    expect(expectOk(second).deletedBlockIds).toEqual([]);
    expect(expectOk(second).blocks.every((placed) => placed.id !== null)).toBe(true);
  });
});

describe('rules 4 + 7 + 8 — a gap overlapping a locked block', () => {
  it('counts the overlap once, fills both holes it leaves and never reaches back', () => {
    const composeInput = input({
      today: MON,
      blocks: [
        block({ project: 'cita', date: MON, from: '10:00', hours: 3, locked: true }),
        block({ project: 'escalera', date: MON, from: '13:00', hours: 5 }),
      ],
      // Overlaps the last hour of the locked block and runs on through lunch.
      gaps: [gap({ date: MON, from: '12:00', hours: 3, reason: 'Gestoría' })],
    });

    // Union: 10:00-14:00 of working time (the 14:00-15:00 tail is lunch).
    expect(plannableMinutes(composeInput, MON)).toBe(600 - 240);

    const result = compose(composeInput);
    // Monday's holes are 08:00-10:00 and 15:30-19:30; neither holds 5 h. The job takes the first two
    // hours and three of the afternoon's four, and the last hour is behind the cursor for ever.
    expect(rows(result)).toEqual([
      `${MON} 08:00-10:00 escalera`,
      `${MON} 10:00-13:00 cita [locked]`,
      `${MON} 15:30-18:30 escalera`,
    ]);
    expectMinutesConserved(composeInput, result);
    expectSettled(composeInput, result);
  });
});

describe('rules 8 + 6 — a job longer than a day that runs into next week', () => {
  it('fills Thursday and the Friday buffer, steps over the weekend and finishes on Monday', () => {
    const composeInput = input({
      today: THU,
      blocks: [block({ project: 'escalera', date: THU, from: '08:00', hours: 30 })],
      grownProjectIds: ['escalera'],
    });

    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${THU} 08:00-14:00 escalera`,
      `${THU} 15:30-19:30 escalera`,
      `${FRI} 08:00-14:00 escalera`,
      `${FRI} 15:30-19:30 escalera`,
      `${NEXT_MON} 08:00-14:00 escalera`,
      `${NEXT_MON} 15:30-19:30 escalera`,
    ]);
    expectMinutesConserved(composeInput, result);
    expect(expectOk(result).blocks.some((placed) => placed.date === SAT || placed.date === SUN)).toBe(false);
  });
});

describe('rule 4 + the visual margins — a block a human dropped outside the periods', () => {
  it('costs the day no plannable time and is handed back untouched', () => {
    // Auto-fill never enters the visual margins.
    const composeInput = input({
      today: MON,
      blocks: [
        block({ project: 'urgente', date: MON, from: '07:00', hours: 1, locked: true }),
        block({ project: 'escalera', date: MON, from: '08:00', hours: 10 }),
      ],
    });

    expect(plannableMinutes(composeInput, MON)).toBe(600);
    expect(rows(compose(composeInput))).toEqual([
      `${MON} 07:00-08:00 urgente [locked]`,
      `${MON} 08:00-14:00 escalera`,
      `${MON} 15:30-19:30 escalera`,
    ]);
  });
});

describe('rule 12 + rule 15 — auto-merge across days', () => {
  it('collapses three rows of one job into one and reports the two ids to delete', () => {
    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'lunes', project: 'escalera', date: MON, from: '08:00', hours: 2 }),
        block({ id: 'martes', project: 'escalera', date: TUE, from: '08:00', hours: 2 }),
        block({ id: 'miercoles', project: 'escalera', date: WED, from: '08:00', hours: 2 }),
      ],
    });

    const result = compose(composeInput);
    expect(rows(result)).toEqual([`${MON} 08:00-14:00 escalera`]);
    expect(expectOk(result).blocks.map((placed) => placed.id)).toEqual(['lunes']);
    expect(expectOk(result).deletedBlockIds).toEqual(['martes', 'miercoles']);
    expectMinutesConserved(composeInput, result);
  });
});

describe('the day capacity is a stop line, not a wall', () => {
  it('stops auto-fill at the capacity even with clock time left, and moves the rest on', () => {
    const composeInput = input({
      today: MON,
      shape: withCapacity(8),
      blocks: [
        block({ project: 'x', date: MON, from: '08:00', hours: 3 }),
        block({ project: 'y', date: MON, from: '11:00', hours: 5 }),
        block({ project: 'z', date: MON, from: '18:00', hours: 1 }),
      ],
    });

    // x + y hit the 8 h stop line exactly: 17:30-19:30 is free clock auto-fill will not use.
    expect(rows(compose(composeInput))).toEqual([
      `${MON} 08:00-11:00 x`,
      `${MON} 11:00-14:00 y`,
      `${MON} 15:30-17:30 y`,
      `${TUE} 08:00-09:00 z`,
    ]);
  });
});

describe('rule 8 — "longer than a day" is measured against the room that actually exists', () => {
  it('splits a job into the holes of one day when no day anywhere has a hole big enough', () => {
    // Every day is cut in two by a five-hour gap, so the biggest stretch anywhere is 4 h: a 6 h job
    // fills the holes it finds, in order, instead of failing.
    const composeInput = input({
      today: MON,
      horizonWeeks: 1,
      blocks: [block({ project: 'escalera', date: MON, from: '08:00', hours: 6 })],
      gaps: [MON, TUE, WED, THU, FRI].map((date) => gap({ date, from: '12:00', hours: 5, reason: 'Feria' })),
    });

    expect(plannableMinutes(composeInput, MON)).toBe(390);

    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${MON} 08:00-12:00 escalera`,
      `${MON} 17:00-19:00 escalera`,
    ]);
    expectMinutesConserved(composeInput, result);
    for (const placed of expectOk(result).blocks) expectInsideOneWorkingPeriod(placed);
  });
});

describe('invariant 4 — the engine never leaves a row shorter than a quarter of an hour', () => {
  // An off-grid TOTAL is reachable: the one sub-quarter row a drop can leave behind, deleted, takes
  // those minutes off `total_hours`, and from then on every layout could leave 1-14 minutes over.

  it('leaves a full quarter for the tail instead of a sliver', () => {
    // 20 h 05 at 10 h a day: Monday 10 h, and then 5 minutes would be left over.
    const composeInput = input({
      today: MON,
      blocks: [block({ project: 'alfa', date: MON, from: '08:00', hours: 1205 / 60 })],
    });

    const result = compose(composeInput);

    expect(rows(result)).toEqual([
      `${MON} 08:00-14:00 alfa`,
      `${MON} 15:30-19:30 alfa`,
      `${TUE} 08:00-14:00 alfa`,
      `${TUE} 15:30-19:20 alfa`,
      `${WED} 08:00-08:15 alfa`,
    ]);
    expectMinutesConserved(composeInput, result);
    expectSettled(composeInput, result);
  });

  it('draws what is left when there is nowhere at all that could hold it whole', () => {
    // The honest boundary: with a total under half an hour and every day holding ten minutes, no
    // split avoids a short row. Refusing would be `horizon-exceeded`, which rolls the save back.
    const composeInput = input({
      today: MON,
      blocks: [block({ project: 'alfa', date: MON, from: '08:00', hours: 20 / 60 })],
      shape: withCapacity(10 / 60),
    });

    const result = compose(composeInput);

    expect(rows(result)).toEqual([`${MON} 08:00-08:10 alfa`, `${TUE} 08:00-08:10 alfa`]);
    expectMinutesConserved(composeInput, result);
    expectSettled(composeInput, result);
  });

  it('steps over a ten-minute hole rather than storing a ten-minute row', () => {
    // The sharp edge of *fill and overflow*: a day may be asked for ten minutes, which is not a row.
    // The 6 h job leaves those ten minutes alone and starts after the lock.
    const composeInput = input({
      today: MON,
      blocks: [
        block({ project: 'cita', date: MON, from: '08:10', hours: 170 / 60, locked: true }),
        block({ project: 'alfa', date: MON, from: '11:00', hours: 6 }),
      ],
    });

    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${MON} 08:10-11:00 cita [locked]`,
      `${MON} 11:00-14:00 alfa`,
      `${MON} 15:30-18:30 alfa`,
    ]);
    expectMinutesConserved(composeInput, result);
    expectSettled(composeInput, result);
  });

  it('carries a quarter of an hour on WHOLE rather than splitting it into ten and five', () => {
    // The other half: a quarter of an hour IS a row, so a ten-minute hole may not have ten minutes of
    // it. Alfa's last quarter waits for Tuesday. (2000-seed harness, seed 57.)
    const composeInput = input({
      today: MON,
      blocks: [
        block({ project: 'alfa', date: MON, from: '08:00', hours: 595 / 60 }),
        block({ project: 'cita', date: MON, from: '19:10', hours: 10 / 60, locked: true }),
      ],
    });

    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${MON} 08:00-14:00 alfa`,
      `${MON} 15:30-19:10 alfa`,
      `${MON} 19:10-19:20 cita [locked]`,
      // 19:20-19:30 is ten free minutes the last quarter of an hour may not be cut into.
      `${TUE} 08:00-08:15 alfa`,
    ]);
    expectMinutesConserved(composeInput, result);
    expectSettled(composeInput, result);
  });

  it('never lets a break cut a piece into a sliver: a period ends, the hours do not', () => {
    // A free stretch spanning the break is ONE stretch to the arithmetic and TWO rows on the clock,
    // so the floor is per row: an obstacle ending at 13:50 used to give a ten-minute row (seed 275).
    const composeInput = input({
      today: MON,
      blocks: [
        block({ project: 'cita', date: MON, from: '08:00', hours: 350 / 60, locked: true }),
        block({ project: 'alfa', date: MON, from: '14:00', hours: 3 }),
      ],
    });

    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${MON} 08:00-13:50 cita [locked]`,
      `${MON} 15:30-18:30 alfa`,
    ]);
    expectMinutesConserved(composeInput, result);
    expectSettled(composeInput, result);
  });
});

describe('a locked block can never make placement fail', () => {
  it('flows a job past a day locked and gapped end to end, with no error', () => {
    // A locked block can never make placement fail, and Monday here has no plannable minute left.
    const composeInput = input({
      today: MON,
      blocks: [
        block({ project: 'cita', date: MON, from: '08:00', hours: 6, locked: true }),
        block({ project: 'escalera', date: MON, from: '17:00', hours: 2 }),
      ],
      gaps: [gap({ date: MON, from: '15:30', hours: 4, reason: 'Inventario' })],
    });

    expect(plannableMinutes(composeInput, MON)).toBe(0);

    const result = compose(composeInput);
    expect(result.ok).toBe(true);
    expect(rows(result)).toEqual([
      `${MON} 08:00-14:00 cita [locked]`,
      `${TUE} 08:00-10:00 escalera`,
    ]);
  });
});

describe('every input row is accounted for exactly once', () => {
  it('either keeps an id on a row or reports it as deleted, never both and never neither', () => {
    const composeInput = input({
      today: TUE,
      blocks: [
        block({ id: 'pasado', project: 'historial', date: LAST_FRI, from: '08:00', hours: 4 }),
        block({ id: 'fijo', project: 'barandilla', date: TUE, from: '10:00', hours: 3, locked: true }),
        block({ id: 'finde', project: 'urgencia', date: SAT, from: '09:00', hours: 3 }),
        block({ id: 'e1', project: 'escalera', date: TUE, from: '13:00', hours: 2 }),
        block({ id: 'e2', project: 'escalera', date: WED, from: '08:00', hours: 9 }),
        block({ id: 'p1', project: 'porton', date: WED, from: '17:00', hours: 4 }),
        block({ id: 'nuevo', project: 'nuevo', date: THU, from: '08:00', hours: 3 }),
      ],
      gaps: [gap({ date: WED, from: '12:00', hours: 2, reason: 'Revisión' })],
      newProjectIds: ['nuevo'],
    });

    const result = expectOk(compose(composeInput));
    const kept = result.blocks.map((placed) => placed.id).filter((id): id is string => id !== null);
    const seen = [...kept, ...result.deletedBlockIds].sort();

    expect(seen).toEqual(composeInput.blocks.map((b) => b.id).sort());
    expect(new Set(seen).size).toBe(seen.length);
    expectMinutesConserved(composeInput, result);
    for (const placed of result.blocks) expectInsideOneWorkingPeriod(placed);
  });

  it('has nothing to say about an empty calendar', () => {
    const result = expectOk(compose(input({ today: MON })));
    expect(result.blocks).toEqual([]);
    expect(result.deletedBlockIds).toEqual([]);
  });
});

describe('the horizon bounds where work sits, not which work is considered', () => {
  it('pulls a block parked months ahead back to today', () => {
    // A Tuesday well beyond the 8-week horizon, unlocked and not past, so it is in the movable pool
    // and comes back: the horizon only limits where the engine may WRITE.
    const composeInput = input({
      today: MON,
      blocks: [block({ project: 'olvidado', date: '2026-12-01', from: '10:00', hours: 4 })],
    });

    expect(rows(compose(composeInput))).toEqual([`${MON} 08:00-12:00 olvidado`]);
  });
});

// ---------------------------------------------------------------------------
// The engine has to SETTLE. Every rule above describes one recomposition; these describe the second,
// which must change nothing — recomposition runs on every mutating operation and there is no undo.
// ---------------------------------------------------------------------------

describe('recomposing twice is not a second reflow', () => {
  it('settles in one pass when a fixed block ranks between two runs of one job', () => {
    // The queue used to break a run at any fixed block, so these two runs were two items placed a day
    // each; the reflow then moved one in front of the lock that had separated them and the NEXT pass
    // saw one item and repacked it. Monday's block grew by an hour on a save that touched nothing.
    const composeInput = input({
      today: MON,
      shape: withCapacity(4),
      blocks: [
        block({ id: 'lunes', project: 'barandilla', date: MON, from: '12:00', hours: 3 }),
        block({ id: 'cita', project: 'revision', date: WED, from: '08:30', hours: 2.5, locked: true }),
        block({ id: 'viernes', project: 'barandilla', date: FRI, from: '16:30', hours: 3.5 }),
      ],
    });

    expect(buildQueue(composeInput).map((item) => item.blockIds)).toEqual([['lunes', 'viernes']]);

    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${MON} 08:00-12:00 barandilla`,
      `${TUE} 08:00-10:30 barandilla`,
      `${WED} 08:30-11:00 revision [locked]`,
    ]);
    expectSettled(composeInput, result);
    expectMinutesConserved(composeInput, result);
  });

  it('settles a job the owner split by hand around a locked block on the same day', () => {
    // The halves are one item again — a fixed row does not break a run — and that costs nothing: the
    // item fills the hole in front of the lock and carries on after it.
    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'antes', project: 'escalera', date: MON, from: '08:00', hours: 2 }),
        block({ id: 'cita', project: 'revision', date: MON, from: '10:00', hours: 1, locked: true }),
        block({ id: 'despues', project: 'escalera', date: MON, from: '11:00', hours: 2 }),
      ],
    });

    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${MON} 08:00-10:00 escalera`,
      `${MON} 10:00-11:00 revision [locked]`,
      `${MON} 11:00-13:00 escalera`,
    ]);
    expectSettled(composeInput, result);

    // Lock the morning half and it stays exactly where the owner put it.
    const pinned = input({
      today: MON,
      blocks: [
        block({ id: 'antes', project: 'escalera', date: MON, from: '08:00', hours: 2, locked: true }),
        block({ id: 'cita', project: 'revision', date: MON, from: '10:00', hours: 1, locked: true }),
        block({ id: 'despues', project: 'escalera', date: MON, from: '11:00', hours: 2 }),
      ],
    });
    expect(rows(compose(pinned))).toEqual([
      `${MON} 08:00-10:00 escalera [locked]`,
      `${MON} 10:00-11:00 revision [locked]`,
      `${MON} 11:00-13:00 escalera`,
    ]);
  });

  it('settles a calendar full of locked, past and weekend rows', () => {
    const composeInput = input({
      today: TUE,
      shape: withCapacity(6),
      blocks: [
        block({ project: 'historial', date: LAST_FRI, from: '08:00', hours: 4 }),
        block({ project: 'cita', date: TUE, from: '10:00', hours: 2, locked: true }),
        block({ project: 'escalera', date: TUE, from: '13:00', hours: 7 }),
        block({ project: 'urgencia', date: SAT, from: '09:00', hours: 3 }),
        block({ project: 'porton', date: WED, from: '17:00', hours: 5 }),
        block({ project: 'escalera', date: THU, from: '08:00', hours: 2 }),
      ],
      gaps: [gap({ date: WED, from: '12:00', hours: 2, reason: 'Revisión' })],
    });

    const result = compose(composeInput);
    expectSettled(composeInput, result);
    expectMinutesConserved(composeInput, result);
    for (const placed of expectOk(result).blocks) expectInsideOneWorkingPeriod(placed);
  });
});

// ---------------------------------------------------------------------------
// Rule 5, the half that only shows up on the SECOND save
// ---------------------------------------------------------------------------

describe('rule 5 — the buffer belongs to growth, and only to growth', () => {
  it('keeps the new job off Friday on the save after the one that created it', () => {
    // "New" is a property of one operation, so on the next save the job was ordinary work and slid
    // onto the Friday it had just skipped. Friday is opt-in for growth, not opt-out for new jobs.
    const creating = input({
      today: MON,
      shape: withCapacity(4),
      blocks: [
        block({ project: 'escalera', date: MON, from: '08:00', hours: 16 }),
        block({ project: 'nuevo', date: MON, from: '13:00', hours: 2 }),
      ],
      newProjectIds: ['nuevo'],
    });

    const created = compose(creating);
    expect(rows(created)).toEqual([
      `${MON} 08:00-12:00 escalera`,
      `${TUE} 08:00-12:00 escalera`,
      `${WED} 08:00-12:00 escalera`,
      `${THU} 08:00-12:00 escalera`,
      `${NEXT_MON} 08:00-10:00 nuevo`,
    ]);
    // The next save — a rename, a deleted gap, anything at all.
    expectSettled(creating, created);
  });

  it('does not hand the buffer to work displaced by something else', () => {
    // Overflow caused by a new job taking the head of the queue is not growth: nobody's hours went
    // up, so Friday stays clear and the displaced work waits for Monday.
    const composeInput = input({
      today: MON,
      shape: withCapacity(4),
      blocks: [
        // Dropped at the head of the queue, in front of the existing work.
        block({ project: 'nuevo', date: MON, from: '07:30', hours: 2 }),
        block({ project: 'vieja', date: MON, from: '08:00', hours: 16 }),
      ],
      newProjectIds: ['nuevo'],
    });

    const result = compose(composeInput);
    expect(rows(result).some((row) => row.startsWith(FRI))).toBe(false);
    expect(rows(result)).toEqual([
      `${MON} 08:00-10:00 nuevo`,
      `${MON} 10:00-12:00 vieja`,
      `${TUE} 08:00-12:00 vieja`,
      `${WED} 08:00-12:00 vieja`,
      `${THU} 08:00-12:00 vieja`,
      `${NEXT_MON} 08:00-10:00 vieja`,
    ]);
    expectSettled(composeInput, result);
  });

  it('leaves absorbed overflow on Friday until Monday to Thursday can take it back', () => {
    const grew = input({
      today: MON,
      shape: withCapacity(4),
      blocks: [block({ project: 'escalera', date: MON, from: '08:00', hours: 20 })],
      grownProjectIds: ['escalera'],
    });

    const absorbed = compose(grew);
    expect(rows(absorbed)).toEqual([
      `${MON} 08:00-12:00 escalera`,
      `${TUE} 08:00-12:00 escalera`,
      `${WED} 08:00-12:00 escalera`,
      `${THU} 08:00-12:00 escalera`,
      `${FRI} 08:00-12:00 escalera`,
    ]);
    // No later save may push those hours off the buffer and into next week...
    expectSettled(grew, absorbed);

    // ...but the moment Monday to Thursday has room, they come back on their own.
    const roomier = input({
      today: MON,
      blocks: reload(absorbed),
    });
    expect(rows(compose(roomier))).toEqual([
      `${MON} 08:00-14:00 escalera`,
      `${MON} 15:30-19:30 escalera`,
      `${TUE} 08:00-14:00 escalera`,
      `${TUE} 15:30-19:30 escalera`,
    ]);
  });

  it('gives the buffer to the job that grew and to no one else in the same save', () => {
    const composeInput = input({
      today: MON,
      shape: withCapacity(4),
      blocks: [
        block({ project: 'escalera', date: MON, from: '08:00', hours: 16 }),
        block({ project: 'creciente', date: MON, from: '13:00', hours: 3 }),
        block({ project: 'porton', date: MON, from: '14:00', hours: 2 }),
      ],
      grownProjectIds: ['creciente'],
    });

    // The grown job takes the buffer; the door is ordinary work, so it waits for next Monday even
    // though Friday still has an hour free.
    expect(rows(compose(composeInput))).toEqual([
      `${MON} 08:00-12:00 escalera`,
      `${TUE} 08:00-12:00 escalera`,
      `${WED} 08:00-12:00 escalera`,
      `${THU} 08:00-12:00 escalera`,
      `${FRI} 08:00-11:00 creciente`,
      `${NEXT_MON} 08:00-10:00 porton`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// More places where two rules meet
// ---------------------------------------------------------------------------

describe('rules 8 + 14 — a job longer than a day stepping over a closed day', () => {
  it('fills complete days, skips the holiday and finishes after it', () => {
    const composeInput = input({
      today: MON,
      shape: withCapacity(6),
      overrides: [closedDay(WED, 'Festivo local')],
      blocks: [block({ project: 'escalera', date: MON, from: '08:00', hours: 20 })],
      grownProjectIds: ['escalera'],
    });

    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${MON} 08:00-14:00 escalera`,
      `${TUE} 08:00-14:00 escalera`,
      `${THU} 08:00-14:00 escalera`,
      `${FRI} 08:00-10:00 escalera`,
    ]);
    expectMinutesConserved(composeInput, result);
    expectSettled(composeInput, result);
  });
});

describe('rules 2 + 10 — today is a Saturday', () => {
  it('starts the reflow on Monday and leaves the weekend where it is', () => {
    const composeInput = input({
      today: SAT,
      blocks: [
        block({ project: 'urgencia', date: SAT, from: '09:00', hours: 3 }),
        block({ project: 'escalera', date: NEXT_MON, from: '17:00', hours: 4 }),
      ],
    });

    expect(plannableMinutes(composeInput, SAT)).toBe(0);
    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${SAT} 09:00-12:00 urgencia`,
      `${NEXT_MON} 08:00-12:00 escalera`,
    ]);
    expectSettled(composeInput, result);
  });
});

describe('rules 4 + 3 — a shift with the afternoon switched off', () => {
  it('plans against the morning alone and carries the rest to the next day', () => {
    const morningOnly: DayShape = withWindows({
      periods: [{ startMinutes: t('08:00'), endMinutes: t('14:00') }],
      shiftMinutes: 360,
      capacityMinutes: 360,
      marginTopMinutes: 60,
      marginBottomMinutes: 60,
      timelineStartMinutes: t('07:00'),
      timelineEndMinutes: t('15:00'),
    });

    const composeInput = input({
      today: MON,
      shape: morningOnly,
      blocks: [block({ project: 'escalera', date: MON, from: '08:00', hours: 10 })],
    });

    expect(plannableMinutes(composeInput, MON)).toBe(360);
    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${MON} 08:00-14:00 escalera`,
      `${TUE} 08:00-12:00 escalera`,
    ]);
    for (const placed of expectOk(result).blocks) expectInsideOneWorkingPeriod(placed, morningOnly);
    expectSettled(composeInput, result);
  });
});

describe('rule 4 + the visual margins — an UNLOCKED block dropped outside the periods', () => {
  it('is pulled back into the working periods on the next recomposition', () => {
    // The consequence of two rules meeting: the margins take a manual drop, and an unlocked block is
    // in the movable pool, so a drop into a margin lasts until the next recomposition.
    const composeInput = input({
      today: MON,
      blocks: [block({ project: 'urgente', date: MON, from: '07:00', hours: 1 })],
    });

    expect(rows(compose(composeInput))).toEqual([`${MON} 08:00-09:00 urgente`]);

    const locked = input({
      today: MON,
      blocks: [block({ project: 'urgente', date: MON, from: '07:00', hours: 1, locked: true })],
    });
    expect(rows(compose(locked))).toEqual([`${MON} 07:00-08:00 urgente [locked]`]);
  });
});

describe('rule 14 — a day override that closes auto-fill without closing the day', () => {
  it('treats a zero-hour stop line as no room, and still lets locked work sit there', () => {
    const composeInput = input({
      today: MON,
      overrides: [dayCapacity(MON, 0)],
      blocks: [
        block({ project: 'cita', date: MON, from: '10:00', hours: 2, locked: true }),
        block({ project: 'escalera', date: MON, from: '13:00', hours: 3 }),
      ],
    });

    expect(plannableMinutes(composeInput, MON)).toBe(0);
    expect(rows(compose(composeInput))).toEqual([
      `${MON} 10:00-12:00 cita [locked]`,
      `${TUE} 08:00-11:00 escalera`,
    ]);
  });
});

describe('rule 13 — the horizon has a floor', () => {
  it('treats a horizon below one week as one week rather than as nowhere to write', () => {
    expect(horizonEndDate(MON, 0)).toBe(SUN);
    expect(horizonEndDate(MON, -3)).toBe(SUN);

    const composeInput = input({
      today: MON,
      horizonWeeks: 0,
      blocks: [block({ project: 'escalera', date: MON, from: '08:00', hours: 3 })],
    });
    expect(rows(compose(composeInput))).toEqual([`${MON} 08:00-11:00 escalera`]);
  });
});

// ---------------------------------------------------------------------------
// Editing a job's hours — LIFO and the resize transfer
// ---------------------------------------------------------------------------

describe('rule — Job Editing: Adding/Removing Hours (LIFO)', () => {
  const job = (): Block[] => [
    block({ id: 'lunes', project: 'escalera', date: MON, from: '08:00', hours: 2 }),
    block({ id: 'miercoles', project: 'escalera', date: WED, from: '08:00', hours: 1 }),
    block({ id: 'viernes', project: 'escalera', date: FRI, from: '08:00', hours: 3 }),
  ];

  it("appends added hours to the job's last block", () => {
    // Mon 2 h + Wed 1 h + Fri 3 h, adding 2 h makes Fri 5 h.
    const edit = expectEdited(
      changeProjectMinutes(job(), {
        projectId: 'escalera',
        deltaMinutes: 120,
        today: MON,
        newBlockId: 'creado',
        now: '2026-08-10 09:00:00',
      }),
    );

    expect(jobRows(edit.blocks, 'escalera')).toEqual([
      `${MON} 08:00-10:00`,
      `${WED} 08:00-09:00`,
      `${FRI} 08:00-13:00`,
    ]);
    expect(edit.totalMinutesDelta).toBe(120);
    expect(edit.deletedBlockIds).toEqual([]);
  });

  it('decrements from the last block, deleting each one that reaches zero', () => {
    const edit = expectEdited(
      changeProjectMinutes(job(), {
        projectId: 'escalera',
        deltaMinutes: -240,
        today: MON,
        newBlockId: 'creado',
        now: '2026-08-10 09:00:00',
      }),
    );

    // 3 h off Friday empties it, and the last hour comes off Wednesday.
    expect(jobRows(edit.blocks, 'escalera')).toEqual([`${MON} 08:00-10:00`]);
    expect(edit.deletedBlockIds.sort()).toEqual(['miercoles', 'viernes']);
    expect(edit.totalMinutesDelta).toBe(-240);
  });

  it('grows the last UNLOCKED block, never a locked one', () => {
    // A locked block is never grown or shrunk silently.
    const blocks = [
      block({ id: 'lunes', project: 'escalera', date: MON, from: '08:00', hours: 2 }),
      block({ id: 'cita', project: 'escalera', date: FRI, from: '08:00', hours: 3, locked: true }),
    ];

    const edit = expectEdited(
      changeProjectMinutes(blocks, {
        projectId: 'escalera',
        deltaMinutes: 120,
        today: MON,
        newBlockId: 'creado',
        now: '2026-08-10 09:00:00',
      }),
    );

    expect(jobRows(edit.blocks, 'escalera')).toEqual([`${MON} 08:00-12:00`, `${FRI} 08:00-11:00 [locked]`]);
    expect(edit.touchedLockedBlockIds).toEqual([]);
  });

  it('creates a row ranked after the job when every block of it is locked', () => {
    const blocks = [block({ id: 'cita', project: 'escalera', date: MON, from: '08:00', hours: 2, locked: true })];

    const edit = expectEdited(
      changeProjectMinutes(blocks, {
        projectId: 'escalera',
        deltaMinutes: 90,
        today: MON,
        newBlockId: 'creado',
        now: '2026-08-10 09:00:00',
      }),
    );

    const created = edit.blocks.find((candidate) => candidate.id === 'creado');
    expect(created).toBeDefined();
    expect(created?.locked).toBe(false);
    expect(created?.durationMinutes).toBe(90);
    // Ranked immediately after the locked row, so the queue keeps the job together.
    expect(`${created?.date} ${minutesToHHmm(created?.startMinutes ?? 0)}`).toBe(`${MON} 10:00`);

    // And the engine places it like any other row.
    const composeInput = input({ today: MON, blocks: edit.blocks });
    expect(rows(compose(composeInput))).toEqual([
      `${MON} 08:00-10:00 escalera [locked]`,
      `${MON} 10:00-11:30 escalera`,
    ]);
  });

  it('never grows a padlocked buffer row: the added hours get a row the engine can place', () => {
    // The same reasoning as for a lock, and it matters more here: hours written onto a row the reflow
    // cannot touch land straight on the clock, where nothing segments them afterwards.
    const pinned = [
      block({ id: 'colchon', project: 'porton', date: FRI, from: '10:00', hours: 2, locked: true }),
    ];

    const edit = expectEdited(
      changeProjectMinutes(pinned, {
        projectId: 'porton',
        deltaMinutes: 4 * 60,
        today: MON,
        newBlockId: 'nueva',
        now: '2026-08-10 09:00:00',
      }),
    );

    expect(edit.blocks.find((row) => row.id === 'colchon')?.durationMinutes).toBe(120);
    expect(edit.blocks.find((row) => row.id === 'nueva')?.durationMinutes).toBe(240);
    // ...and the engine places those hours from the front of the week, leaving the pinned row alone.
    expect(rows(compose(input({ today: MON, blocks: edit.blocks })))).toEqual([
      `${MON} 08:00-12:00 porton`,
      `${FRI} 10:00-12:00 porton [locked]`,
    ]);
  });

  it('takes hours off a padlocked row only when the job has nothing else, and says so', () => {
    // The other direction: shrinking frees space rather than claiming it, so LIFO may reach a
    // padlocked row — but only after the rows the engine still owns, and never silently.
    const pinned = () => [
      block({ id: 'automatico', project: 'porton', date: MON, from: '08:00', hours: 2 }),
      block({ id: 'colchon', project: 'porton', date: FRI, from: '10:00', hours: 2, locked: true }),
    ];

    const first = expectEdited(
      changeProjectMinutes(pinned(), {
        projectId: 'porton',
        deltaMinutes: -60,
        today: MON,
        newBlockId: 'nueva',
        now: '2026-08-10 09:00:00',
      }),
    );

    expect(first.blocks.find((row) => row.id === 'automatico')?.durationMinutes).toBe(60);
    expect(first.blocks.find((row) => row.id === 'colchon')?.durationMinutes).toBe(120);
    expect(first.touchedLockedBlockIds).toEqual([]);

    const rest = expectEdited(
      changeProjectMinutes(pinned(), {
        projectId: 'porton',
        deltaMinutes: -3 * 60,
        today: MON,
        newBlockId: 'nueva',
        now: '2026-08-10 09:00:00',
      }),
    );

    expect(rest.blocks.find((row) => row.id === 'automatico')).toBeUndefined();
    expect(rest.blocks.find((row) => row.id === 'colchon')?.durationMinutes).toBe(60);
    expect(rest.touchedLockedBlockIds).toEqual(['colchon']);
  });

  it('never grows a row in the FROZEN PAST: the added hours get a row the engine can place', () => {
    // The defect that took the calendar page down: a job whose one row sits on YESTERDAY, raised from
    // 2 h to 6 h, stored `Tue 12:00 + 360 min` through the break, and at 13 h `12:00-25:00`. No
    // gesture is needed to reach it — a row on today becomes a past row overnight. `lastAutomatic`
    // tested the stored marks while its own rule is "every row outside the movable pool".
    const yesterday = [block({ id: 'ayer', project: 'escalera', date: TUE, from: '12:00', hours: 2 })];

    const edit = expectEdited(
      changeProjectMinutes(yesterday, {
        projectId: 'escalera',
        deltaMinutes: 4 * 60,
        today: WED,
        newBlockId: 'nueva',
        now: '2026-08-12 09:00:00',
      }),
    );

    // Yesterday's record is untouched, and the 4 h are a row of their own.
    expect(edit.blocks.find((row) => row.id === 'ayer')?.durationMinutes).toBe(120);
    expect(edit.blocks.find((row) => row.id === 'nueva')?.durationMinutes).toBe(240);
    // ...which the engine then places on the calendar it still owns.
    const composeInput = input({ today: WED, blocks: edit.blocks });
    const result = compose(composeInput);
    expect(rows(result)).toEqual([`${TUE} 12:00-14:00 escalera`, `${WED} 08:00-12:00 escalera`]);
    expectMinutesConserved(composeInput, result);
    for (const placed of expectOk(result).blocks) expectInsideOneWorkingPeriod(placed);
  });

  it('never grows a WEEKEND row either — the pool is the rule, not the mark', () => {
    // The weekend was masked only in practice: every hand drop onto Sat/Sun leaves a padlock, so a
    // row that never went through that gesture — an imported or hand-edited one — was grown too.
    const saturday = [block({ id: 'sabado', project: 'porton', date: SAT, from: '12:00', hours: 2 })];

    const edit = expectEdited(
      changeProjectMinutes(saturday, {
        projectId: 'porton',
        deltaMinutes: 4 * 60,
        today: MON,
        newBlockId: 'nueva',
        now: '2026-08-10 09:00:00',
      }),
    );

    expect(edit.blocks.find((row) => row.id === 'sabado')?.durationMinutes).toBe(120);
    expect(edit.blocks.find((row) => row.id === 'nueva')?.durationMinutes).toBe(240);
    expect(rows(compose(input({ today: MON, blocks: edit.blocks })))).toEqual([
      `${MON} 08:00-12:00 porton`,
      `${SAT} 12:00-14:00 porton`,
    ]);
  });

  it('still takes hours OFF a past row, since shrinking one frees space', () => {
    // The asymmetry: LIFO has to reach the job's hours wherever they are, and taking hours away can
    // never produce a row that runs over the day's other work or past its end.
    const yesterday = [
      block({ id: 'ayer', project: 'escalera', date: TUE, from: '12:00', hours: 2 }),
      block({ id: 'sabado', project: 'escalera', date: SAT, from: '12:00', hours: 1 }),
    ];

    const edit = expectEdited(
      changeProjectMinutes(yesterday, {
        projectId: 'escalera',
        deltaMinutes: -150,
        today: WED,
        newBlockId: 'nueva',
        now: '2026-08-12 09:00:00',
      }),
    );

    // The Saturday row empties and the last half hour comes off yesterday: LIFO from the far end.
    expect(edit.deletedBlockIds).toEqual(['sabado']);
    expect(edit.blocks.find((row) => row.id === 'ayer')?.durationMinutes).toBe(30);
    expect(edit.totalMinutesDelta).toBe(-150);
  });

  it('reports a reduction bigger than the job instead of inventing negative hours', () => {
    const result = changeProjectMinutes(job(), {
      projectId: 'escalera',
      deltaMinutes: -600,
      today: MON,
      newBlockId: 'creado',
      now: '2026-08-10 09:00:00',
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('a job cannot give up more hours than it has');
    expect(result.error.code).toBe('reduction-exceeds-job');
    expect(result.error.messageKey).toMatch(/^[a-zA-Z][\w.]*$/);
  });

  it('touches a locked row only when the job has nothing else left, and says so', () => {
    const blocks = [block({ id: 'cita', project: 'escalera', date: MON, from: '08:00', hours: 3, locked: true })];

    const edit = expectEdited(
      changeProjectMinutes(blocks, {
        projectId: 'escalera',
        deltaMinutes: -60,
        today: MON,
        newBlockId: 'creado',
        now: '2026-08-10 09:00:00',
      }),
    );

    expect(jobRows(edit.blocks, 'escalera')).toEqual([`${MON} 08:00-10:00 [locked]`]);
    expect(edit.touchedLockedBlockIds).toEqual(['cita']);
  });
});

describe('rule — Block Resize (drag the bottom edge) is a transfer inside the job', () => {
  /*
   * THE ROW BEING SIZED ALWAYS CARRIES A PADLOCK, in every test here: the edge only sizes rows the
   * engine does not lay out, and elsewhere the request is refused with `resize-needs-padlock`. The
   * COUNTERPARTY is the opposite — always a row the engine still places.
   */
  const job = (): Block[] => [
    block({ id: 'lunes', project: 'escalera', date: MON, from: '08:00', hours: 2, locked: true }),
    block({ id: 'viernes', project: 'escalera', date: FRI, from: '08:00', hours: 3 }),
  ];

  /** The same job with the padlock on its LAST row, for the cases with nothing behind it. */
  const lastPinned = (): Block[] => [
    block({ id: 'lunes', project: 'escalera', date: MON, from: '08:00', hours: 2 }),
    block({ id: 'viernes', project: 'escalera', date: FRI, from: '08:00', hours: 3, locked: true }),
  ];

  it("changes the JOB'S HOURS on a row the engine lays out, and transfers on a padlocked one", () => {
    // The edge is available on both, and it means two different things. On an automatic row there is
    // no drawing to fix — the reflow would re-derive it — so what the gesture changes is how much
    // work there is, and the engine places it. On a padlocked row the length is the owner's, so the
    // hours come out of the job's other rows and the estimate is untouched.
    const automatic = [
      block({ id: 'mie', project: 'escalera', date: WED, from: '08:00', hours: 6 }),
      block({ id: 'jue', project: 'escalera', date: THU, from: '08:00', hours: 4 }),
    ];

    // GROWING is applied straight: 6 h -> 8 h adds 2 h to the job.
    const grown = expectEdited(
      resizeBlock(automatic, resizing({ blockId: 'mie', durationMinutes: 8 * 60, today: WED })),
    );
    expect(grown.totalMinutesDelta).toBe(2 * 60);

    // SHRINKING destroys hours, so it asks — and `new-block` is not offered, because a row of its
    // own of this same job, unpinned, is placed straight back where these hours already were.
    const asked = resizeBlock(automatic, resizing({ blockId: 'mie', durationMinutes: 120, today: WED }));
    expect(asked.ok).toBe(false);
    if (asked.ok) throw new Error('shrinking an automatic row must ask');
    expect(asked.error.code).toBe('shrink-needs-choice');
    expect(asked.error.choices).toEqual(['reduce-total']);
    expect(asked.error.freedMinutes).toBe(4 * 60);

    const answered = expectEdited(
      resizeBlock(
        automatic,
        resizing({ blockId: 'mie', durationMinutes: 120, today: WED, freedHours: 'reduce-total' }),
      ),
    );
    expect(answered.totalMinutesDelta).toBe(-4 * 60);

    // The same request on a PADLOCKED row is the transfer, and the estimate does not move.
    const pinned = automatic.map((row) => (row.id === 'mie' ? { ...row, locked: true } : row));
    const edit = expectEdited(resizeBlock(pinned, resizing({ blockId: 'mie', durationMinutes: 120, today: WED })));
    expect(edit.totalMinutesDelta).toBe(0);
    expect(jobRows(edit.blocks, 'escalera')).toEqual([`${WED} 08:00-10:00 [locked]`, `${THU} 08:00-16:00`]);
  });

  it('refuses it on a Friday and inside a margin too — the pool is the whole question', () => {
    // Every row the engine moves: the colchón is in the pool, and a margin row is only ever there
    // WITH a padlock, which is what makes it sizable.
    const friday = [
      block({ id: 'colchon', project: 'escalera', date: FRI, from: '08:00', hours: 3 }),
      block({ id: 'lunes', project: 'escalera', date: MON, from: '08:00', hours: 2 }),
    ];
    expect(resizeBlock(friday, resizing({ blockId: 'colchon', durationMinutes: 120, today: MON })).ok).toBe(false);

    // A weekend row is outside the pool by DATE, so it needs no padlock; its counterparty is the
    // job's row after it.
    const weekend = [
      block({ id: 'sabado', project: 'escalera', date: SAT, from: '09:00', hours: 2 }),
      block({ id: 'lunes', project: 'escalera', date: NEXT_MON, from: '08:00', hours: 3 }),
    ];
    const edit = expectEdited(resizeBlock(weekend, resizing({ blockId: 'sabado', durationMinutes: 60, today: MON })));
    expect(jobRows(edit.blocks, 'escalera')).toEqual([`${SAT} 09:00-10:00`, `${NEXT_MON} 08:00-12:00`]);
  });

  it('takes the hours off the last block when a block that is not the last grows', () => {
    const edit = expectEdited(resizeBlock(job(), resizing({ blockId: 'lunes', durationMinutes: 240, today: MON })));

    expect(jobRows(edit.blocks, 'escalera')).toEqual([`${MON} 08:00-12:00 [locked]`, `${FRI} 08:00-09:00`]);
    expect(edit.totalMinutesDelta).toBe(0);
  });

  it('gives the hours to the last block when a block that is not the last shrinks', () => {
    const edit = expectEdited(resizeBlock(job(), resizing({ blockId: 'lunes', durationMinutes: 60, today: MON })));

    expect(jobRows(edit.blocks, 'escalera')).toEqual([`${MON} 08:00-09:00 [locked]`, `${FRI} 08:00-12:00`]);
    expect(edit.totalMinutesDelta).toBe(0);
  });

  it("raises the job's total when the LAST block grows, since there is nothing farther to draw from", () => {
    const edit = expectEdited(
      resizeBlock(lastPinned(), resizing({ blockId: 'viernes', durationMinutes: 300, today: MON })),
    );

    expect(jobRows(edit.blocks, 'escalera')).toEqual([`${MON} 08:00-10:00`, `${FRI} 08:00-13:00 [locked]`]);
    expect(edit.totalMinutesDelta).toBe(120);
  });

  it('ASKS when the last block shrinks, instead of refusing, and names what it freed', () => {
    // Growing the last row raises the estimate; shrinking it used to be a flat 409. There is nothing
    // to hand the hours to, so the transform stops and asks — hours and answers in one round trip.
    const result = resizeBlock(lastPinned(), resizing({ blockId: 'viernes', durationMinutes: 60, today: MON }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('shrinking the last block must ask');
    expect(result.error.code).toBe('shrink-needs-choice');
    expect(result.error.blockId).toBe('viernes');
    expect(result.error.freedMinutes).toBe(120);
    expect(result.error.choices).toEqual(['reduce-total', 'new-block']);
  });

  it('takes the freed hours off the job when the owner answers `reduce-total`', () => {
    const edit = expectEdited(
      resizeBlock(
        lastPinned(),
        resizing({ blockId: 'viernes', durationMinutes: 60, today: MON, freedHours: 'reduce-total' }),
      ),
    );

    expect(jobRows(edit.blocks, 'escalera')).toEqual([`${MON} 08:00-10:00`, `${FRI} 08:00-09:00 [locked]`]);
    expect(edit.totalMinutesDelta).toBe(-120);
  });

  it('leaves the freed hours as a row of their own when the owner answers `new-block`', () => {
    const edit = expectEdited(
      resizeBlock(
        lastPinned(),
        resizing({ blockId: 'viernes', durationMinutes: 60, today: MON, freedHours: 'new-block' }),
      ),
    );

    // The job keeps its 5 h, the standalone 2 h ranked after its last row for `compose` to place.
    expect(edit.totalMinutesDelta).toBe(0);
    expect(minutesByProject(edit.blocks)).toEqual({ escalera: 300 });
    expect(edit.blocks).toHaveLength(3);
  });

  it('offers only `reduce-total` for hours too few to be a row', () => {
    // A quarter of an hour is the smallest row the calendar can draw, so a 10-minute block is not one
    // of the ways out — and the caller is told rather than left to work it out.
    const blocks = [
      block({ id: 'solo', project: 'escalera', date: MON, from: '08:00', hours: 2, locked: true }),
    ];
    const result = resizeBlock(blocks, resizing({ blockId: 'solo', durationMinutes: 110, today: MON }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('the question must be asked');
    expect(result.error.freedMinutes).toBe(10);
    expect(result.error.choices).toEqual(['reduce-total']);

    // And asking for the missing one is refused rather than quietly obeyed.
    expect(
      resizeBlock(blocks, resizing({ blockId: 'solo', durationMinutes: 110, today: MON, freedHours: 'new-block' })).ok,
    ).toBe(false);
  });

  it('cascades backwards past a locked row to find the receiver', () => {
    // A padlocked row is never grown silently, so the cascading hours stop at the row before it.
    const blocks = [
      block({ id: 'lunes', project: 'escalera', date: MON, from: '08:00', hours: 3, locked: true }),
      block({ id: 'martes', project: 'escalera', date: TUE, from: '08:00', hours: 1 }),
      block({ id: 'jueves', project: 'escalera', date: THU, from: '08:00', hours: 2, locked: true }),
    ];

    const edit = expectEdited(resizeBlock(blocks, resizing({ blockId: 'lunes', durationMinutes: 60, today: MON })));

    expect(jobRows(edit.blocks, 'escalera')).toEqual([
      `${MON} 08:00-09:00 [locked]`,
      `${TUE} 08:00-11:00`,
      `${THU} 08:00-10:00 [locked]`,
    ]);
    expect(edit.totalMinutesDelta).toBe(0);
    expect(edit.touchedLockedBlockIds).toEqual([]);
  });

  it('asks when every counterparty is outside the pool, rather than writing onto one', () => {
    // The hours would land on a row nothing will ever re-lay out, where a raw duration stays on the
    // clock for ever, so the dead end is the same one and the owner is asked instead.
    const blocks = [
      block({ id: 'mar', project: 'escalera', date: TUE, from: '08:00', hours: 3, locked: true }),
      block({ id: 'sabado', project: 'escalera', date: SAT, from: '12:00', hours: 2 }),
    ];

    const result = resizeBlock(blocks, resizing({ blockId: 'mar', durationMinutes: 60, today: TUE }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('the question must be asked');
    expect(result.error.code).toBe('shrink-needs-choice');
    expect(result.error.freedMinutes).toBe(120);
  });

  it('refuses a growth the rest of the job cannot pay for', () => {
    const result = resizeBlock(job(), resizing({ blockId: 'lunes', durationMinutes: 600, today: MON }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('the transfer must be refused');
    expect(result.error.code).toBe('transfer-exceeds-job');
  });

  it('deletes a counterparty the transfer empties, cascading backwards', () => {
    const blocks = [
      block({ id: 'lunes', project: 'escalera', date: MON, from: '08:00', hours: 2, locked: true }),
      block({ id: 'martes', project: 'escalera', date: TUE, from: '08:00', hours: 1 }),
      block({ id: 'viernes', project: 'escalera', date: FRI, from: '08:00', hours: 1 }),
    ];

    const edit = expectEdited(resizeBlock(blocks, resizing({ blockId: 'lunes', durationMinutes: 240, today: MON })));

    expect(jobRows(edit.blocks, 'escalera')).toEqual([`${MON} 08:00-12:00 [locked]`]);
    expect(edit.deletedBlockIds.sort()).toEqual(['martes', 'viernes']);
    expect(edit.totalMinutesDelta).toBe(0);
  });

  it('refuses a PAST row through the pool as well, so the record cannot be rewritten', () => {
    // The operation refuses it first with `past-block-frozen`; the pure engine's own answer is the
    // transfer, since a past row is outside the pool. The past is a policy of the write path.
    const blocks = [
      block({ id: 'ayer', project: 'escalera', date: MON, from: '08:00', hours: 2 }),
      block({ id: 'jueves', project: 'escalera', date: THU, from: '08:00', hours: 4 }),
    ];

    const edit = expectEdited(resizeBlock(blocks, resizing({ blockId: 'ayer', durationMinutes: 180, today: TUE })));
    expect(edit.totalMinutesDelta).toBe(0);

    const composeInput = input({ today: TUE, blocks: edit.blocks });
    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${MON} 08:00-11:00 escalera`,
      `${TUE} 08:00-11:00 escalera`,
    ]);
    expectMinutesConserved(composeInput, result);
  });

  it('hands the freed hours to a row the ENGINE lays out, not to a weekend row behind it', () => {
    // The same predicate as LIFO's: a transfer that ADDS hours to a row the reflow cannot touch writes
    // them straight onto the clock. The last row is on Saturday, so only the pool tells them apart.
    const blocks = [
      block({ id: 'mar', project: 'escalera', date: TUE, from: '08:00', hours: 3, locked: true }),
      block({ id: 'jue', project: 'escalera', date: THU, from: '08:00', hours: 2 }),
      block({ id: 'sabado', project: 'escalera', date: SAT, from: '12:00', hours: 2 }),
    ];

    const edit = expectEdited(resizeBlock(blocks, resizing({ blockId: 'mar', durationMinutes: 60, today: TUE })));

    expect(jobRows(edit.blocks, 'escalera')).toEqual([
      `${TUE} 08:00-09:00 [locked]`,
      `${THU} 08:00-12:00`,
      `${SAT} 12:00-14:00`,
    ]);
    expect(edit.totalMinutesDelta).toBe(0);
  });

  it('rejects a duration that is not a duration', () => {
    expect(resizeBlock(job(), resizing({ blockId: 'lunes', durationMinutes: 0, today: MON })).ok).toBe(false);
    expect(resizeBlock(job(), resizing({ blockId: 'lunes', durationMinutes: -60, today: MON })).ok).toBe(false);
    expect(resizeBlock(job(), resizing({ blockId: 'no-existe', durationMinutes: 60, today: MON })).ok).toBe(false);
  });

  it('adds no mark of its own — the padlock the row already had is the whole story', () => {
    // A success stores a duration and nothing else, so a resize to the length the row had is a no-op.
    const grown = expectEdited(resizeBlock(job(), resizing({ blockId: 'lunes', durationMinutes: 240, today: MON })));
    expect(lockedIds(grown.blocks)).toEqual(['lunes']);
    expect(Object.keys(grown.blocks[0]).includes('manualDuration')).toBe(false);

    const unchanged = expectEdited(
      resizeBlock(job(), resizing({ blockId: 'lunes', durationMinutes: 120, today: MON })),
    );
    expect(jobRows(unchanged.blocks, 'escalera')).toEqual(jobRows(job(), 'escalera'));
    expect(unchanged.totalMinutesDelta).toBe(0);

    // A refusal writes nothing: growing the last row past what the job has cannot be paid for.
    expect(resizeBlock(job(), resizing({ blockId: 'lunes', durationMinutes: 600, today: MON })).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The padlock is what holds a length
// ---------------------------------------------------------------------------
//
// A block is exactly as big as the room it has, and the padlock is what holds a length: the engine
// does not lay a locked row out, does not merge one and does not re-derive its length, so the number
// the owner drew simply stays. No support rules are needed for that.

describe('the padlock holds a resized length, and needs no second mark to do it', () => {
  /** Barandilla 14 h from Wednesday, Porton 8 h behind it. */
  const worked = (): Block[] => [
    block({ id: 'bar-am', project: 'barandilla', date: WED, from: '08:00', hours: 6 }),
    block({ id: 'bar-pm', project: 'barandilla', date: WED, from: '15:30', hours: 4 }),
    block({ id: 'bar-jue', project: 'barandilla', date: THU, from: '08:00', hours: 4 }),
    block({ id: 'porton', project: 'porton', date: THU, from: '12:00', hours: 8 }),
  ];

  /** The same calendar with the Wednesday morning row padlocked — the sizable one. */
  const pinnedMorning = (): Block[] =>
    worked().map((row) => (row.id === 'bar-am' ? { ...row, locked: true } : row));

  const AUTOMATIC = [
    `${WED} 08:00-14:00 barandilla`,
    `${WED} 15:30-19:30 barandilla`,
    `${THU} 08:00-12:00 barandilla`,
    `${THU} 12:00-14:00 porton`,
    `${THU} 15:30-19:30 porton`,
    `${NEXT_MON} 08:00-10:00 porton`,
  ];

  it('lays the calendar out the same way whether a row is padlocked or not', () => {
    // The padlock costs nothing while the row is where the engine would have put it anyway.
    const composeInput = input({ today: WED, blocks: worked() });
    expect(rows(compose(composeInput))).toEqual(AUTOMATIC);

    const pinned = input({ today: WED, blocks: pinnedMorning() });
    expect(rows(compose(pinned))).toEqual([
      `${WED} 08:00-14:00 barandilla [locked]`,
      ...AUTOMATIC.slice(1),
    ]);
    expectSettled(pinned, compose(pinned));
  });

  it('the worked example: the shrunk row keeps its 2 h and the jobs behind fill the day', () => {
    const edit = expectEdited(
      resizeBlock(pinnedMorning(), resizing({ blockId: 'bar-am', durationMinutes: 120, today: WED })),
    );

    // The ordinary transfer: the 4 h come off Wednesday onto the job's last row the engine places.
    expect(jobRows(edit.blocks, 'barandilla')).toEqual([
      `${WED} 08:00-10:00 [locked]`,
      `${WED} 15:30-19:30`,
      `${THU} 08:00-16:00`,
    ]);
    expect(edit.totalMinutesDelta).toBe(0);

    const composeInput = input({ today: WED, blocks: edit.blocks });
    const result = compose(composeInput);

    // Wednesday's freed hours go to whatever the queue has next, by ordinary forward fill.
    expect(rows(result)).toEqual([
      `${WED} 08:00-10:00 barandilla [locked]`,
      // The job's OWN remaining hours take the room the shrink freed, which is the point rather than
      // a defect: what ends a day early is a gap, and only the owner makes one.
      `${WED} 10:00-14:00 barandilla`,
      `${WED} 15:30-19:30 barandilla`,
      `${THU} 08:00-12:00 barandilla`,
      // Strict order, unbroken: Porton still follows Barandilla everywhere.
      `${THU} 12:00-14:00 porton`,
      `${THU} 15:30-19:30 porton`,
      `${NEXT_MON} 08:00-10:00 porton`,
    ]);
    expectMinutesConserved(composeInput, result);
    expectSettled(composeInput, result);
  });

  it('recomposing twice changes nothing — the fixed point the earlier defect broke', () => {
    const edit = expectEdited(
      resizeBlock(pinnedMorning(), resizing({ blockId: 'bar-am', durationMinutes: 120, today: WED })),
    );
    const composeInput = input({ today: WED, blocks: edit.blocks });

    const once = compose(composeInput);
    const twice = compose({ ...composeInput, blocks: reload(once) });
    const thrice = compose({ ...composeInput, blocks: reload(twice) });

    expect(rows(twice)).toEqual(rows(once));
    expect(rows(thrice)).toEqual(rows(once));
    expect(expectOk(twice).deletedBlockIds).toEqual([]);
    // The 2 h are still 2 h, and still padlocked: nothing else was needed to keep them.
    expect(
      expectOk(twice)
        .blocks.filter((placed) => placed.locked)
        .map(describeBlock),
    ).toEqual([`${WED} 08:00-10:00 barandilla [locked]`]);
  });

  it('survives an unrelated save: another job created, and a job deleted', () => {
    const edit = expectEdited(
      resizeBlock(pinnedMorning(), resizing({ blockId: 'bar-am', durationMinutes: 120, today: WED })),
    );

    // A brand-new job appended at the end of the queue.
    const withNewJob = input({
      today: WED,
      blocks: [...edit.blocks, block({ id: 'nuevo', project: 'remate', date: NEXT_MON, from: '10:00', hours: 2 })],
      newProjectIds: ['remate'],
    });
    expect(rows(compose(withNewJob))).toContain(`${WED} 08:00-10:00 barandilla [locked]`);

    // Deleting Porton frees Thursday. The padlocked 2 h stay 2 h, and the job's own remaining hours DO
    // flow back into the hours the shrink freed.
    const withoutPorton = input({
      today: WED,
      blocks: edit.blocks.filter((row) => row.projectId !== 'porton'),
    });
    const result = compose(withoutPorton);
    expect(rows(result)).toEqual([
      `${WED} 08:00-10:00 barandilla [locked]`,
      `${WED} 10:00-14:00 barandilla`,
      `${WED} 15:30-19:30 barandilla`,
      `${THU} 08:00-12:00 barandilla`,
    ]);
    expectSettled(withoutPorton, result);
  });

  it('gives the length back to the engine when the PADLOCK comes off — the one undo', () => {
    const edit = expectEdited(
      resizeBlock(pinnedMorning(), resizing({ blockId: 'bar-am', durationMinutes: 120, today: WED })),
    );

    // Pressing the padlock: the row rejoins its job's run and the calendar is automatic again.
    const unlocked = edit.blocks.map((row) => ({ ...row, locked: false }));
    expect(rows(compose(input({ today: WED, blocks: unlocked })))).toEqual(AUTOMATIC);
  });

  it('makes a padlocked row an OBSTACLE, never a queue item, and never a run divider', () => {
    // A padlocked row is not an item at all, and it does not end the run around it: the job's rows
    // either side of it are ONE item, which is why the reflow can hop it.
    const beside = input({
      today: WED,
      blocks: [
        block({ id: 'fijo', project: 'escalera', date: WED, from: '08:00', hours: 2, locked: true }),
        block({ id: 'resto', project: 'escalera', date: WED, from: '10:00', hours: 3 }),
        block({ id: 'mas', project: 'escalera', date: THU, from: '08:00', hours: 1 }),
      ],
    });
    expect(buildQueue(beside).map((item) => item.blockIds)).toEqual([['resto', 'mas']]);
    expect(buildQueue(beside)[0].durationMinutes).toBe(240);
  });

  it('keeps a padlocked stretch cut at the lunch break exactly as it is', () => {
    // 7 h padlocked from 08:00 is two rows, both outside the pool, so the engine hands them back.
    const composeInput = input({
      today: WED,
      blocks: [
        block({ id: 'am', project: 'escalera', date: WED, from: '08:00', hours: 6, locked: true }),
        block({ id: 'pm', project: 'escalera', date: WED, from: '15:30', hours: 1, locked: true }),
      ],
    });
    const result = compose(composeInput);

    expect(rows(result)).toEqual([
      `${WED} 08:00-14:00 escalera [locked]`,
      `${WED} 15:30-16:30 escalera [locked]`,
    ]);
    expectSettled(composeInput, result);
  });

  it('keeps the Friday buffer, the weekend and the frozen past exactly as they were', () => {
    const composeInput = input({
      today: THU,
      blocks: [
        // Yesterday: frozen, so it is an obstacle rather than a queue item.
        block({ id: 'ayer', project: 'historial', date: WED, from: '08:00', hours: 3 }),
        block({ id: 'fijo', project: 'escalera', date: THU, from: '08:00', hours: 2, locked: true }),
        block({ id: 'resto', project: 'escalera', date: THU, from: '10:00', hours: 8 }),
        // A Saturday row a human put there. Never auto-placed, never auto-recovered.
        block({ id: 'sabado', project: 'porton', date: SAT, from: '09:00', hours: 2 }),
      ],
    });
    const result = compose(composeInput);

    expect(rows(result)).toEqual([
      `${WED} 08:00-11:00 historial`,
      `${THU} 08:00-10:00 escalera [locked]`,
      `${THU} 10:00-14:00 escalera`,
      `${THU} 15:30-19:30 escalera`,
      `${SAT} 09:00-11:00 porton`,
    ]);
    expectMinutesConserved(composeInput, result);
    expectSettled(composeInput, result);
  });

  it('lets growth reach Friday past a padlocked row, since the padlock is about ONE row', () => {
    const composeInput = input({
      today: THU,
      blocks: [
        block({ id: 'fijo', project: 'escalera', date: THU, from: '08:00', hours: 2, locked: true }),
        block({ id: 'resto', project: 'escalera', date: THU, from: '10:00', hours: 12 }),
      ],
      grownProjectIds: ['escalera'],
    });

    expect(rows(compose(composeInput))).toEqual([
      `${THU} 08:00-10:00 escalera [locked]`,
      `${THU} 10:00-14:00 escalera`,
      `${THU} 15:30-19:30 escalera`,
      `${FRI} 08:00-12:00 escalera`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// A resize crosses the lunch break, and may reach into the margins
// ---------------------------------------------------------------------------
//
// `durationMinutes` is NET working minutes over the day's MANUAL WINDOWS, and the result is stored
// in segments by the same splitter a drop uses. The drag layer's half — turning a pointer position
// into those net minutes — is `durationTo` in src/components/calendar/geometry.ts.

describe('a resize crosses the lunch break', () => {
  /** A padlocked 10:00 morning row — the only kind the edge sizes — with a Thursday row to pay the
   * transfer and another job in front of it. */
  const job = (): Block[] => [
    block({ id: 'antes', project: 'porton', date: WED, from: '08:00', hours: 2 }),
    block({ id: 'mie', project: 'barandilla', date: WED, from: '10:00', hours: 4, locked: true }),
    block({ id: 'jue', project: 'barandilla', date: THU, from: '08:00', hours: 4 }),
  ];

  it("the owner's worked example: 10:00 to 17:30 is 6 h, in two rows", () => {
    const edit = expectEdited(resizeBlock(job(), resizing({ blockId: 'mie', durationMinutes: 6 * 60, today: WED })));

    // Two rows of one job, the lunch break contributing nothing — and NOT 7.5 h.
    expect(jobRows(edit.blocks, 'barandilla')).toEqual([
      `${WED} 10:00-14:00 [locked]`,
      `${WED} 15:30-17:30 [locked]`,
      `${THU} 08:00-10:00`,
    ]);
    // The created row carries the same padlock: half a stretch left to the engine comes apart.
    expect(lockedIds(edit.blocks)).toEqual(['mie', 'resize-1']);
    expect(edit.totalMinutesDelta).toBe(0);
    expect(edit.deletedBlockIds).toEqual([]);

    const composeInput = input({ today: WED, blocks: edit.blocks });
    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${WED} 08:00-10:00 porton`,
      `${WED} 10:00-14:00 barandilla [locked]`,
      `${WED} 15:30-17:30 barandilla [locked]`,
      // The 2 h left take what Wednesday still has: the padlocked stretch holds only its own hours.
      `${WED} 17:30-19:30 barandilla`,
    ]);
    expectMinutesConserved(composeInput, result);
    expectSettled(composeInput, result);
  });

  it('is a fixed point: recomposing the two halves twice changes nothing', () => {
    const edit = expectEdited(resizeBlock(job(), resizing({ blockId: 'mie', durationMinutes: 6 * 60, today: WED })));
    const composeInput = input({ today: WED, blocks: edit.blocks });

    const once = compose(composeInput);
    const twice = compose({ ...composeInput, blocks: reload(once) });

    expect(rows(twice)).toEqual(rows(once));
    expect(expectOk(twice).deletedBlockIds).toEqual([]);
  });

  it('shrinks back across the break, deleting the row it no longer needs', () => {
    const stretched = expectEdited(
      resizeBlock(job(), resizing({ blockId: 'mie', durationMinutes: 6 * 60, today: WED })),
    );

    // The same edge dragged back to 12:00: the afternoon half is where the segments reached, so it goes.
    const shrunk = expectEdited(
      resizeBlock(stretched.blocks, resizing({ blockId: 'mie', durationMinutes: 2 * 60, today: WED })),
    );

    expect(jobRows(shrunk.blocks, 'barandilla')).toEqual([
      `${WED} 10:00-12:00 [locked]`,
      `${THU} 08:00-14:00`,
    ]);
    expect(shrunk.deletedBlockIds).toEqual(['resize-1']);
    expect(shrunk.totalMinutesDelta).toBe(0);
  });

  it('reuses the row already sitting after the break instead of stacking one on it', () => {
    // Dragged past the break onto its own afternoon half: the new segments land exactly where that row
    // sits, so the stretch takes it over — nothing is stacked at 15:30 and no id is minted.
    const unit = [
      block({ id: 'am', project: 'barandilla', date: WED, from: '08:00', hours: 6, locked: true }),
      block({ id: 'pm', project: 'barandilla', date: WED, from: '15:30', hours: 4, locked: true }),
      block({ id: 'jue', project: 'barandilla', date: THU, from: '08:00', hours: 4 }),
    ];

    const edit = expectEdited(resizeBlock(unit, resizing({ blockId: 'am', durationMinutes: 8 * 60, today: WED })));

    // The stretch went from 10 h to 8 h, so the 2 h it gave up landed on Thursday.
    expect(jobRows(edit.blocks, 'barandilla')).toEqual([
      `${WED} 08:00-14:00 [locked]`,
      `${WED} 15:30-17:30 [locked]`,
      `${THU} 08:00-14:00`,
    ]);
    expect(edit.deletedBlockIds).toEqual([]);
    expect(rows(compose(input({ today: WED, blocks: edit.blocks })))).toEqual([
      `${WED} 08:00-14:00 barandilla [locked]`,
      `${WED} 15:30-17:30 barandilla [locked]`,
      `${WED} 17:30-19:30 barandilla`,
      `${THU} 08:00-12:00 barandilla`,
    ]);
  });

  it('leaves an AUTOMATIC row the stretch does not reach to the engine', () => {
    // The afternoon row here is the ENGINE's, so shrinking the padlocked morning row does not take it
    // in: absorbing it would read "this row is shorter" as "this job is smaller".
    const oneDay = [
      block({ id: 'am', project: 'barandilla', date: WED, from: '08:00', hours: 6, locked: true }),
      block({ id: 'pm', project: 'barandilla', date: WED, from: '15:30', hours: 2 }),
      block({ id: 'jue', project: 'barandilla', date: THU, from: '08:00', hours: 1 }),
    ];

    const edit = expectEdited(resizeBlock(oneDay, resizing({ blockId: 'am', durationMinutes: 120, today: WED })));

    expect(jobRows(edit.blocks, 'barandilla')).toEqual([
      `${WED} 08:00-10:00 [locked]`,
      `${WED} 15:30-17:30`,
      `${THU} 08:00-13:00`,
    ]);
    // The 7 h the engine still owns are ONE queue item, so they fill Wednesday round the padlock.
    expect(minutesByProject(edit.blocks)).toEqual({ barandilla: 540 });
    expect(rows(compose(input({ today: WED, blocks: edit.blocks })))).toEqual([
      `${WED} 08:00-10:00 barandilla [locked]`,
      `${WED} 10:00-14:00 barandilla`,
      `${WED} 15:30-18:30 barandilla`,
    ]);
  });

  it('lets a padlocked row be sized into a visual margin, and keeps it there', () => {
    // The margins are hand time and the engine's index space has no minutes of them. No extra padlock
    // is needed: the row already carries the one that lets it be sized at all.
    const blocks = [
      block({ id: 'tarde', project: 'barandilla', date: WED, from: '15:30', hours: 4, locked: true }),
      block({ id: 'jue', project: 'barandilla', date: THU, from: '08:00', hours: 4 }),
    ];

    const edit = expectEdited(resizeBlock(blocks, resizing({ blockId: 'tarde', durationMinutes: 5 * 60, today: WED })));

    expect(lockedIds(edit.blocks)).toEqual(['tarde']);
    expect(jobRows(edit.blocks, 'barandilla')).toEqual([
      `${WED} 15:30-20:30 [locked]`,
      `${THU} 08:00-11:00`,
    ]);

    // And it holds: the row keeps the hour of margin the owner drew it into.
    const composeInput = input({ today: WED, blocks: edit.blocks });
    const result = compose(composeInput);
    expect(rows(result)).toEqual([
      `${WED} 08:00-11:00 barandilla`,
      `${WED} 15:30-20:30 barandilla [locked]`,
    ]);
    expectSettled(composeInput, result);
  });

  it('never lets AUTO-FILL into the margins, however much work there is', () => {
    // The guard rail on the whole change: `compose` reads `periods` and nothing else, so
    // no amount of pressure can make it book margin time. 40 h across a 10 h-a-day week.
    const composeInput = input({
      today: MON,
      blocks: [block({ project: 'barandilla', date: MON, from: '08:00', hours: 40 })],
    });
    const result = compose(composeInput);

    const [morning, afternoon] = SHAPE.periods;
    for (const placed of expectOk(result).blocks) {
      const withinMorning =
        placed.startMinutes >= morning.startMinutes &&
        placed.startMinutes + placed.durationMinutes <= morning.endMinutes;
      const withinAfternoon =
        placed.startMinutes >= afternoon.startMinutes &&
        placed.startMinutes + placed.durationMinutes <= afternoon.endMinutes;
      expect(withinMorning || withinAfternoon, describeBlock(placed)).toBe(true);
    }
    // The capacity stop-line still measures the periods alone: 10 h a day, not 12.
    expect(plannableMinutes(composeInput, TUE)).toBe(600);
  });
});

// ---------------------------------------------------------------------------
// Manual placement — the overlap a drop creates
// ---------------------------------------------------------------------------
//
// The rows `compose` may not move (weekend, frozen past, locked) come back untouched, so two of them
// can overlap for ever and the reflow will never notice. A hand drop is what creates that:
//   SAME JOB  -> one row, start = min(starts), duration = SUM(durations).
//   OTHER JOB -> cut it at the drop's start and push its tail past the drop's end.
//   A LOCK    -> refuse; never cut, grow or absorb a locked row.

describe('manual placement — the same job merges, and the hours are SUMMED', () => {
  it('turns Sat 09:00-11:00 plus a 2 h drop at 10:00 into one 09:00-13:00 row of 4 h', () => {
    // Both rows are on a weekend, so both are outside the pool the instant they are written.
    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'ya-estaba', project: 'urgencia', date: SAT, from: '09:00', hours: 2 }),
        block({ id: 'soltado', project: 'urgencia', date: SAT, from: '10:00', hours: 2 }),
      ],
    });

    const resolved = expectPlaced(resolveManualPlacement(composeInput, dropOf('soltado')));

    expect(calendarRows(resolved.blocks)).toEqual([`${SAT} 09:00-13:00 urgencia`]);
    // The earlier row survives, so the write is an UPDATE: the same convention auto-merge follows.
    expect(resolved.blocks[0].id).toBe('ya-estaba');
    expect(resolved.mergedBlockIds).toEqual(['soltado']);
    expect(resolved.displacedProjectIds).toEqual([]);
  });

  it('sums the durations instead of taking the interval union, so no hour is lost', () => {
    // The case an interval union fails: 09:00-11:00 plus a 1 h drop at 10:00 would answer 09:00-11:00
    // and lose an hour. The rule is `min(start)` plus the SUM: 3 h, 09:00-12:00.
    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'ya-estaba', project: 'urgencia', date: SAT, from: '09:00', hours: 2 }),
        block({ id: 'soltado', project: 'urgencia', date: SAT, from: '10:00', hours: 1 }),
      ],
    });

    const resolved = expectPlaced(resolveManualPlacement(composeInput, dropOf('soltado')));

    expect(resolved.blocks).toHaveLength(1);
    expect(resolved.blocks[0].durationMinutes).toBe(3 * 60);
    expect(resolved.blocks[0].startMinutes).toBe(t('09:00'));
    expect(resolved.blocks[0].startMinutes + resolved.blocks[0].durationMinutes).toBe(t('12:00'));
    // The invariant, stated as itself: the job came in with 3 h and still has 3 h.
    expect(minutesByProject(resolved.blocks)).toEqual(minutesByProject(composeInput.blocks));
  });

  it('folds a whole stack of overlapping rows of one job into one, keeping every hour', () => {
    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'a', project: 'urgencia', date: SAT, from: '09:00', hours: 1 }),
        block({ id: 'b', project: 'urgencia', date: SAT, from: '09:30', hours: 1 }),
        block({ id: 'soltado', project: 'urgencia', date: SAT, from: '10:00', hours: 1 }),
      ],
    });

    const resolved = expectPlaced(resolveManualPlacement(composeInput, dropOf('soltado')));

    expect(calendarRows(resolved.blocks)).toEqual([`${SAT} 09:00-12:00 urgencia`]);
    expect(minutesByProject(resolved.blocks)).toEqual({ urgencia: 3 * 60 });
  });

  it('does the same on a frozen past day, which the engine may not rewrite either', () => {
    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'ya-estaba', project: 'historial', date: LAST_FRI, from: '09:00', hours: 2 }),
        block({ id: 'soltado', project: 'historial', date: LAST_FRI, from: '10:00', hours: 2 }),
      ],
    });

    const resolved = expectPlaced(resolveManualPlacement(composeInput, dropOf('soltado')));

    expect(calendarRows(resolved.blocks)).toEqual([`${LAST_FRI} 09:00-13:00 historial`]);
  });

  it('leaves a drop the reflow will settle alone — there is nothing to repair', () => {
    // An unlocked weekday row IS movable: the reflow puts it somewhere it overlaps nothing.
    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'ya-estaba', project: 'urgencia', date: TUE, from: '09:00', hours: 2 }),
        block({ id: 'soltado', project: 'urgencia', date: TUE, from: '10:00', hours: 2 }),
      ],
    });

    const resolved = expectPlaced(resolveManualPlacement(composeInput, dropOf('soltado')));

    expect(calendarRows(resolved.blocks)).toEqual([
      `${TUE} 09:00-11:00 urgencia`,
      `${TUE} 10:00-12:00 urgencia`,
    ]);
    expect(resolved.mergedBlockIds).toEqual([]);
  });

  it('is not rule 12: two weekend rows of one job that merely TOUCH stay two rows', () => {
    // Auto-merge joins rows that TOUCH and never runs on the weekend; this is about an OVERLAP, so
    // touching is not its business either.
    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'ya-estaba', project: 'urgencia', date: SAT, from: '09:00', hours: 2 }),
        block({ id: 'soltado', project: 'urgencia', date: SAT, from: '11:00', hours: 2 }),
      ],
    });

    const resolved = expectPlaced(resolveManualPlacement(composeInput, dropOf('soltado')));

    expect(calendarRows(resolved.blocks)).toEqual([
      `${SAT} 09:00-11:00 urgencia`,
      `${SAT} 11:00-13:00 urgencia`,
    ]);
    expect(rows(compose({ ...composeInput, blocks: resolved.blocks }))).toEqual([
      `${SAT} 09:00-11:00 urgencia`,
      `${SAT} 11:00-13:00 urgencia`,
    ]);
  });
});

describe('manual placement — another job is cut and its tail pushed past the drop', () => {
  it('turns A 09:00-11:00 with B dropped at 10:00 into A, B, A with A keeping its 2 h', () => {
    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'a', project: 'barandilla', date: SAT, from: '09:00', hours: 2 }),
        block({ id: 'b', project: 'porton', date: SAT, from: '10:00', hours: 1 }),
      ],
    });

    const resolved = expectPlaced(resolveManualPlacement(composeInput, dropOf('b')));

    expect(calendarRows(resolved.blocks)).toEqual([
      `${SAT} 09:00-10:00 barandilla`,
      `${SAT} 10:00-11:00 porton`,
      `${SAT} 11:00-12:00 barandilla`,
    ]);
    // The drop may be undone by another drop, so the job must not lose hours in the meantime.
    expect(minutesByProject(resolved.blocks)).toEqual(minutesByProject(composeInput.blocks));
    expect(resolved.displacedProjectIds).toEqual(['barandilla']);
    expect(resolved.mergedBlockIds).toEqual([]);
  });

  it('reuses the cut row\'s id when the drop covers it from its very start', () => {
    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'a', project: 'barandilla', date: SAT, from: '09:00', hours: 2 }),
        block({ id: 'b', project: 'porton', date: SAT, from: '09:00', hours: 1 }),
      ],
    });

    const resolved = expectPlaced(resolveManualPlacement(composeInput, dropOf('b')));

    expect(calendarRows(resolved.blocks)).toEqual([
      `${SAT} 09:00-10:00 porton`,
      `${SAT} 10:00-12:00 barandilla`,
    ]);
    // Nothing in front of the drop, so there is no head to keep and the row is rewritten.
    expect(resolved.blocks.find((row) => row.projectId === 'barandilla')?.id).toBe('a');
  });

  it('splits the tail at the lunch break, because a row is a solid rectangle', () => {
    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'a', project: 'barandilla', date: SAT, from: '11:00', hours: 3 }),
        block({ id: 'b', project: 'porton', date: SAT, from: '12:00', hours: 1 }),
      ],
    });

    const resolved = expectPlaced(resolveManualPlacement(composeInput, dropOf('b')));

    // 1 h in front, the drop, then the 2 h left cut at the break: exactly what auto-fill would do.
    expect(calendarRows(resolved.blocks)).toEqual([
      `${SAT} 11:00-12:00 barandilla`,
      `${SAT} 12:00-13:00 porton`,
      `${SAT} 13:00-14:00 barandilla`,
      `${SAT} 15:30-16:30 barandilla`,
    ]);
    expect(minutesByProject(resolved.blocks)).toEqual({ barandilla: 3 * 60, porton: 60 });
  });

  it('carries a Saturday tail that does not fit onto SUNDAY, never onto Monday', () => {
    // Pushing the remainder into the week would decide the shop does not work Saturdays.
    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'a', project: 'barandilla', date: SAT, from: '18:30', hours: 1 }),
        block({ id: 'b', project: 'porton', date: SAT, from: '18:30', hours: 1 }),
      ],
    });

    const resolved = expectPlaced(resolveManualPlacement(composeInput, dropOf('b')));

    expect(calendarRows(resolved.blocks)).toEqual([
      `${SAT} 18:30-19:30 porton`,
      `${SUN} 08:00-09:00 barandilla`,
    ]);
    expect(minutesByProject(resolved.blocks)).toEqual({ barandilla: 60, porton: 60 });
  });

  it('chains a tail off the end of a frozen day into the movable pool, where the reflow takes it', () => {
    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'a', project: 'historial', date: LAST_FRI, from: '18:30', hours: 1 }),
        block({ id: 'b', project: 'revision', date: LAST_FRI, from: '18:30', hours: 1 }),
      ],
    });

    const resolved = expectPlaced(resolveManualPlacement(composeInput, dropOf('b')));

    // Last Friday has no room and the weekend is not this row's to use, so the hour lands on today.
    expect(calendarRows(resolved.blocks)).toEqual([
      `${LAST_FRI} 18:30-19:30 revision`,
      `${MON} 08:00-09:00 historial`,
    ]);
    // And from there it is ordinary movable work.
    expect(rows(compose({ ...composeInput, blocks: resolved.blocks }))).toEqual([
      `${LAST_FRI} 18:30-19:30 revision`,
      `${MON} 08:00-09:00 historial`,
    ]);
  });

  it('steps over a gap when it pushes the tail, since gaps are occupied time', () => {
    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'a', project: 'barandilla', date: SAT, from: '09:00', hours: 2 }),
        block({ id: 'b', project: 'porton', date: SAT, from: '10:00', hours: 1 }),
      ],
      gaps: [gap({ date: SAT, from: '11:00', hours: 1, reason: 'Avería' })],
    });

    const resolved = expectPlaced(resolveManualPlacement(composeInput, dropOf('b')));

    expect(calendarRows(resolved.blocks)).toEqual([
      `${SAT} 09:00-10:00 barandilla`,
      `${SAT} 10:00-11:00 porton`,
      `${SAT} 12:00-13:00 barandilla`,
    ]);
  });

  it('cuts every job the drop lands across, one after another', () => {
    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'a', project: 'barandilla', date: SAT, from: '09:00', hours: 2 }),
        block({ id: 'c', project: 'escalera', date: SAT, from: '11:00', hours: 2 }),
        block({ id: 'b', project: 'porton', date: SAT, from: '10:00', hours: 2 }),
      ],
    });

    const resolved = expectPlaced(resolveManualPlacement(composeInput, dropOf('b')));

    expect(calendarRows(resolved.blocks)).toEqual([
      `${SAT} 09:00-10:00 barandilla`,
      `${SAT} 10:00-12:00 porton`,
      `${SAT} 12:00-13:00 barandilla`,
      `${SAT} 13:00-14:00 escalera`,
      `${SAT} 15:30-16:30 escalera`,
    ]);
    expect(minutesByProject(resolved.blocks)).toEqual(minutesByProject(composeInput.blocks));
    expect([...resolved.displacedProjectIds].sort()).toEqual(['barandilla', 'escalera']);
  });
});

describe('manual placement — a locked row is never overlapped', () => {
  it('refuses a drop that lands on another job\'s locked row, naming it', () => {
    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'cita', project: 'revision', date: SAT, from: '09:00', hours: 2, locked: true }),
        block({ id: 'b', project: 'porton', date: SAT, from: '10:00', hours: 1 }),
      ],
    });

    const result = resolveManualPlacement(composeInput, dropOf('b'));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('a locked row must never be cut');
    expect(result.error.code).toBe('overlaps-locked-block');
    expect(result.error.messageKey).toBe('errors.dropOverLockedBlock');
    expect(result.error.blockId).toBe('cita');
    expect(result.error.projectId).toBe('revision');
    expect(result.error.date).toBe(SAT);
    expect(result.error.startMinutes).toBe(t('09:00'));
  });

  it('still MERGES onto the SAME job\'s padlocked row, and the merged row keeps the padlock', () => {
    // A refusal here would fire on the ordinary gesture — stacking more of one job on the Saturday it
    // already sits on — and name the owner's own row at them. The folded row keeps the padlock.
    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'cita', project: 'urgencia', date: SAT, from: '09:00', hours: 2, locked: true }),
        block({ id: 'soltado', project: 'urgencia', date: SAT, from: '10:00', hours: 2 }),
      ],
    });

    const resolved = expectPlaced(resolveManualPlacement(composeInput, dropOf('soltado')));

    expect(calendarRows(resolved.blocks)).toEqual([`${SAT} 09:00-13:00 urgencia [locked]`]);
    expect(resolved.mergedBlockIds).toEqual(['soltado']);
    expect(minutesByProject(resolved.blocks)).toEqual(minutesByProject(composeInput.blocks));
  });

  it('carries the padlock the other way too: a padlocked DROP onto an unlocked row', () => {
    // The survivor is the earlier row, so without this the fold would hand pinned hours back.
    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'ya-estaba', project: 'urgencia', date: SAT, from: '09:00', hours: 2 }),
        block({ id: 'soltado', project: 'urgencia', date: SAT, from: '10:00', hours: 2, locked: true }),
      ],
    });

    const resolved = expectPlaced(resolveManualPlacement(composeInput, dropOf('soltado')));

    expect(calendarRows(resolved.blocks)).toEqual([`${SAT} 09:00-13:00 urgencia [locked]`]);
  });

  it('says nothing about a locked row the drop merely touches', () => {
    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'cita', project: 'revision', date: SAT, from: '09:00', hours: 2, locked: true }),
        block({ id: 'b', project: 'porton', date: SAT, from: '11:00', hours: 1 }),
      ],
    });

    expect(expectPlaced(resolveManualPlacement(composeInput, dropOf('b'))).mergedBlockIds).toEqual([]);
  });

  it('lets a LOCKED drop displace an unlocked weekend row — the lock is the drop\'s own', () => {
    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'a', project: 'barandilla', date: SAT, from: '09:00', hours: 2 }),
        block({ id: 'b', project: 'porton', date: SAT, from: '10:00', hours: 1, locked: true }),
      ],
    });

    const resolved = expectPlaced(resolveManualPlacement(composeInput, dropOf('b')));

    expect(calendarRows(resolved.blocks)).toEqual([
      `${SAT} 09:00-10:00 barandilla`,
      `${SAT} 10:00-11:00 porton [locked]`,
      `${SAT} 11:00-12:00 barandilla`,
    ]);
  });

  it('refuses a merge whose sum would run past midnight, rather than clipping it', () => {
    // A row is a solid rectangle inside ONE day, so there is nowhere for the rest of the hours to go —
    // and clipping them is the one thing the sum rule exists to prevent.
    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'ya-estaba', project: 'urgencia', date: SAT, from: '22:00', hours: 2 }),
        block({ id: 'soltado', project: 'urgencia', date: SAT, from: '23:00', hours: 1 }),
      ],
    });

    const result = resolveManualPlacement(composeInput, dropOf('soltado'));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('the merge must not run past midnight');
    expect(result.error.code).toBe('merge-exceeds-day');
    expect(result.error.messageKey).toBe('errors.mergeExceedsDay');
    expect(result.error.date).toBe(SAT);
  });

  it('refuses when the displaced hours have nowhere left inside the horizon', () => {
    // One week of horizon: the Saturday tail may only try Saturday and Sunday, and Sunday is full.
    const composeInput = input({
      today: MON,
      horizonWeeks: 1,
      blocks: [
        block({ id: 'a', project: 'barandilla', date: SAT, from: '18:30', hours: 1 }),
        block({ id: 'b', project: 'porton', date: SAT, from: '18:30', hours: 1 }),
        block({ id: 'domingo-am', project: 'escalera', date: SUN, from: '08:00', hours: 6 }),
        block({ id: 'domingo-pm', project: 'escalera', date: SUN, from: '15:30', hours: 4 }),
      ],
    });

    const result = resolveManualPlacement(composeInput, dropOf('b'));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('the displaced hours must not vanish');
    expect(result.error.code).toBe('displaced-hours-unplaceable');
    expect(result.error.messageKey).toBe('errors.displacedHoursUnplaceable');
    expect(result.error.projectId).toBe('barandilla');
  });

  it('reports an unknown row rather than resolving nothing quietly', () => {
    const result = resolveManualPlacement(input({ today: MON }), dropOf('fantasma'));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('an unknown row must be reported');
    expect(result.error.code).toBe('unknown-block');
    expect(result.error.messageKey).toBe('errors.unknownBlock');
  });
});

describe('manual placement — a drop the engine still owns is never refused', () => {
  // Every refusal above answers "does the footprint fit here as the calendar stands right now", which
  // where the reflow decides the layout is circular: the room on the target day is made BY the move.
  // A drop that PADLOCKS lands literally, so it keeps its day and gives up the exact minute — and
  // where the day has no clear slot the refusal stands, because the pin cannot be taken off quietly.

  it('knows which days it lays out: Mon-Thu and the buffer, from today on', () => {
    const config = createDayConfigResolver(SHAPE, [closedDay(WED)]);
    expect(dayReflows(config(TUE), TUE, MON)).toBe(true);
    // Friday IS in the movable pool — that is how the colchón self-cleans.
    expect(dayReflows(config(FRI), FRI, MON)).toBe(true);
    expect(dayReflows(config(SAT), SAT, MON)).toBe(false);
    expect(dayReflows(config(SUN), SUN, MON)).toBe(false);
    expect(dayReflows(config(WED), WED, MON)).toBe(false);
    expect(dayReflows(config(LAST_FRI), LAST_FRI, MON)).toBe(false);
  });

  it('slides a pinned Friday drop clear of a gap instead of refusing it', () => {
    // A drop onto the buffer PINS, so it cannot share the gap's minutes, and a rank would be worthless
    // there. Keeping the day and giving up the exact minute is the only answer that honours it.
    const composeInput = input({
      today: MON,
      gaps: [gap({ date: FRI, from: '10:00', hours: 1, reason: 'Avería' })],
      blocks: [block({ id: 'soltado', project: 'porton', date: FRI, from: '10:00', hours: 2, locked: true })],
    });

    const resolved = expectPlaced(resolveManualPlacement(composeInput, dropOf('soltado')));

    expect(calendarRows(resolved.blocks)).toEqual([`${FRI} 11:00-13:00 porton [locked]`]);
    expect(resolved.blocks[0].locked).toBe(true);
    expect(minutesByProject(resolved.blocks)).toEqual(minutesByProject(composeInput.blocks));
  });

  it('slides past a LOCKED row on the buffer, and stores the result in segments', () => {
    // The lock keeps its minutes; the drop takes the first it can, across the break, so two rows.
    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'cita', project: 'revision', date: FRI, from: '09:00', hours: 2, locked: true }),
        block({ id: 'soltado', project: 'porton', date: FRI, from: '09:00', hours: 6, locked: true }),
      ],
    });

    const resolved = expectPlaced(resolveManualPlacement(composeInput, dropOf('soltado')));

    expect(calendarRows(resolved.blocks)).toEqual([
      `${FRI} 09:00-11:00 revision [locked]`,
      `${FRI} 11:00-14:00 porton [locked]`,
      `${FRI} 15:30-18:30 porton [locked]`,
    ]);
    expect(minutesByProject(resolved.blocks)).toEqual(minutesByProject(composeInput.blocks));
  });

  it('refuses, naming the gap, when the day has no clear slot left', () => {
    // The gap runs to the end of Friday, so there is nowhere to slide, and the drop is padlocked: the
    // answer is a refusal the owner can act on, not a silent unlocking.
    const composeInput = input({
      today: MON,
      gaps: [gap({ date: FRI, from: '09:00', hours: 11, reason: 'Puente' })],
      blocks: [block({ id: 'soltado', project: 'porton', date: FRI, from: '10:00', hours: 2, locked: true })],
    });

    const result = resolveManualPlacement(composeInput, dropOf('soltado'));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('a padlocked drop over a gap must be refused');
    expect(result.error.code).toBe('overlaps-gap');
    expect(result.error.reason).toBe('Puente');
  });

  it('never slides a row past the end of the day to get clear', () => {
    // Forward only, and the end of the day is a line no write may cross: the first slot clear of this
    // gap is 19:00, where a 2 h row would reach 21:00. So there is no slot.
    const composeInput = input({
      today: MON,
      gaps: [gap({ date: FRI, from: '18:00', hours: 1, reason: 'Limpieza' })],
      blocks: [block({ id: 'soltado', project: 'porton', date: FRI, from: '18:00', hours: 2, locked: true })],
    });

    const result = resolveManualPlacement(composeInput, dropOf('soltado'));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('a drop with nowhere to slide to must be refused');
    expect(result.error.code).toBe('overlaps-gap');
  });

  it('still refuses the same drop on the WEEKEND, where the minute is the whole promise', () => {
    const composeInput = input({
      today: MON,
      gaps: [gap({ date: SAT, from: '10:00', hours: 1, reason: 'Avería' })],
      blocks: [block({ id: 'soltado', project: 'porton', date: SAT, from: '10:00', hours: 2 })],
    });

    const result = resolveManualPlacement(composeInput, dropOf('soltado'));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('a drop onto a gap on the weekend must be refused');
    expect(result.error.code).toBe('overlaps-gap');
    expect(result.error.reason).toBe('Avería');
  });

  it('slides a locked row being DRAGGED too, on a day that reflows', () => {
    // The padlock says "the engine does not move this row", not "the owner may not aim it". On a day
    // the engine lays out it gets the same answer as a drop onto the buffer, which IS a padlocked drop.
    const composeInput = input({
      today: MON,
      gaps: [gap({ date: FRI, from: '10:00', hours: 1, reason: 'Avería' })],
      blocks: [block({ id: 'soltado', project: 'porton', date: FRI, from: '10:00', hours: 2, locked: true })],
    });

    const resolved = expectPlaced(resolveManualPlacement(composeInput, dropOf('soltado')));

    expect(calendarRows(resolved.blocks)).toEqual([`${FRI} 11:00-13:00 porton [locked]`]);
  });

  it('refuses that same drag where the day is NOT the engine\'s: the weekend', () => {
    // No slide there: the minute is the whole promise, and nothing will ever separate the rows.
    const composeInput = input({
      today: MON,
      gaps: [gap({ date: SAT, from: '10:00', hours: 1, reason: 'Avería' })],
      blocks: [block({ id: 'soltado', project: 'porton', date: SAT, from: '10:00', hours: 2, locked: true })],
    });

    const result = resolveManualPlacement(composeInput, dropOf('soltado'));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('a locked drop onto a gap on the weekend must be refused');
    expect(result.error.code).toBe('overlaps-gap');
    expect(result.error.date).toBe(SAT);
  });
});

describe('manual placement — what it hands to the engine is already settled', () => {
  it('leaves a calendar the reflow changes nothing about', () => {
    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'lunes', project: 'escalera', date: MON, from: '08:00', hours: 4 }),
        block({ id: 'a', project: 'barandilla', date: SAT, from: '09:00', hours: 2 }),
        block({ id: 'b', project: 'porton', date: SAT, from: '10:00', hours: 1 }),
      ],
    });

    const resolved = expectPlaced(resolveManualPlacement(composeInput, dropOf('b')));
    const placement = compose({ ...composeInput, blocks: resolved.blocks });

    expect(rows(placement)).toEqual([
      `${MON} 08:00-12:00 escalera`,
      `${SAT} 09:00-10:00 barandilla`,
      `${SAT} 10:00-11:00 porton`,
      `${SAT} 11:00-12:00 barandilla`,
    ]);
    expectMinutesConserved({ ...composeInput, blocks: resolved.blocks }, placement);
    expectSettled({ ...composeInput, blocks: resolved.blocks }, placement);
  });
});

// ---------------------------------------------------------------------------
// A drop onto a row the reflow WILL settle
// ---------------------------------------------------------------------------
//
// Dropping Porton at Wednesday 10:00, inside Barandilla's 08:00-14:00 row, used to land it at 15:30
// and push Barandilla to Thursday, because nothing cut the row and the queue read `A, B`. The cut
// makes it read `A, B, A`, and the forward fill does the rest: no hours are placed here, only ranked.

describe('a drop onto a movable row is cut too, so the queue reads A, B, A', () => {
  const dropped = (): Block[] => [
    block({ id: 'bar', project: 'barandilla', date: WED, from: '08:00', hours: 6 }),
    // Porton, just dropped at 10:00 — inside Barandilla's row.
    block({ id: 'porton', project: 'porton', date: WED, from: '10:00', hours: 2 }),
  ];

  it('cuts the row at the drop and the engine draws A, B, A', () => {
    const composeInput = input({ today: WED, blocks: dropped() });

    // Without the cut the queue reads `barandilla, porton` and Porton lands after the whole 6 h block.
    expect(rows(compose(composeInput))).toEqual([
      `${WED} 08:00-14:00 barandilla`,
      `${WED} 15:30-17:30 porton`,
    ]);

    const resolved = expectPlaced(resolveManualPlacement(composeInput, dropOf('porton')));
    expect(resolved.displacedProjectIds).toEqual(['barandilla']);
    expect(resolved.mergedBlockIds).toEqual([]);
    expect(resolved.placedBlockId).toBe('porton');

    const placement = compose({ ...composeInput, blocks: resolved.blocks });
    expect(rows(placement)).toEqual([
      `${WED} 08:00-10:00 barandilla`,
      `${WED} 10:00-12:00 porton`,
      `${WED} 12:00-14:00 barandilla`,
      `${WED} 15:30-17:30 barandilla`,
    ]);
    // Barandilla keeps every one of its 6 h; the cut moved hours, it did not spend them.
    expectMinutesConserved({ ...composeInput, blocks: resolved.blocks }, placement);
    expectSettled({ ...composeInput, blocks: resolved.blocks }, placement);
  });

  it('resolving the same drop again does nothing — there is no overlap left', () => {
    const composeInput = input({ today: WED, blocks: dropped() });
    const once = expectPlaced(resolveManualPlacement(composeInput, dropOf('porton')));
    const twice = expectPlaced(
      resolveManualPlacement({ ...composeInput, blocks: once.blocks }, dropOf('porton')),
    );

    expect(twice.displacedProjectIds).toEqual([]);
    expect(calendarRows(twice.blocks)).toEqual(calendarRows(once.blocks));
  });

  it('leaves a row that starts at or after the drop alone — it already ranks behind it', () => {
    const composeInput = input({
      today: WED,
      blocks: [
        block({ id: 'porton', project: 'porton', date: WED, from: '08:00', hours: 2 }),
        block({ id: 'bar', project: 'barandilla', date: WED, from: '08:30', hours: 4 }),
      ],
    });

    const resolved = expectPlaced(resolveManualPlacement(composeInput, dropOf('porton')));
    expect(resolved.displacedProjectIds).toEqual([]);
    expect(calendarRows(resolved.blocks)).toEqual(calendarRows(composeInput.blocks));
  });

  it('goes BEFORE a row it landed exactly on the start of, and cuts nothing', () => {
    // Landing on a start means "put me before this one". The rank TIES there and a tie goes to
    // `created_at`, so the drop lost to the older row: Barandilla is deliberately the older.
    const composeInput = input({
      today: WED,
      blocks: [
        block({ id: 'bar', project: 'barandilla', date: WED, from: '08:00', hours: 4 }),
        block({ id: 'porton', project: 'porton', date: WED, from: '08:00', hours: 2 }),
      ],
    });

    const resolved = expectPlaced(resolveManualPlacement(composeInput, dropOf('porton')));
    // Nothing was cut and nobody's hours moved: the row underneath simply follows.
    expect(resolved.displacedProjectIds).toEqual([]);
    expect(resolved.mergedBlockIds).toEqual([]);
    expect(resolved.blocks).toHaveLength(2);

    const placement = compose({ ...composeInput, blocks: resolved.blocks });
    expect(rows(placement)).toEqual([
      `${WED} 08:00-10:00 porton`,
      `${WED} 10:00-14:00 barandilla`,
    ]);
    expectMinutesConserved({ ...composeInput, blocks: resolved.blocks }, placement);
    expectSettled({ ...composeInput, blocks: resolved.blocks }, placement);
  });

  it('never cuts a locked row, and never refuses the drop over one', () => {
    // Flexible work flows around a lock, so this must not become the 409 a weekend drop gets.
    const composeInput = input({
      today: WED,
      blocks: [
        block({ id: 'bar', project: 'barandilla', date: WED, from: '08:00', hours: 6, locked: true }),
        block({ id: 'porton', project: 'porton', date: WED, from: '10:00', hours: 2 }),
      ],
    });

    const resolved = expectPlaced(resolveManualPlacement(composeInput, dropOf('porton')));
    expect(resolved.displacedProjectIds).toEqual([]);
    expect(calendarRows(resolved.blocks)).toEqual(calendarRows(composeInput.blocks));

    const placement = compose({ ...composeInput, blocks: resolved.blocks });
    expect(rows(placement)).toEqual([
      `${WED} 08:00-14:00 barandilla [locked]`,
      `${WED} 15:30-17:30 porton`,
    ]);
  });

  it('leaves a drop onto the job\'s OWN movable row to the reflow', () => {
    // Two movable rows of one job are laid out contiguously and joined by auto-merge anyway.
    const composeInput = input({
      today: WED,
      blocks: [
        block({ id: 'primero', project: 'escalera', date: WED, from: '08:00', hours: 4 }),
        block({ id: 'segundo', project: 'escalera', date: WED, from: '10:00', hours: 2 }),
      ],
    });

    const resolved = expectPlaced(resolveManualPlacement(composeInput, dropOf('segundo')));
    expect(resolved.mergedBlockIds).toEqual([]);
    expect(resolved.displacedProjectIds).toEqual([]);
    expect(rows(compose({ ...composeInput, blocks: resolved.blocks }))).toEqual([
      `${WED} 08:00-14:00 escalera`,
    ]);
  });

});

// ---------------------------------------------------------------------------
// A dropped row is stored in segments, like every other row
// ---------------------------------------------------------------------------
//
// A hand drop is the one placement that does not go through `toClockSegments`, so dropping 360 min at
// 10:00 stored ONE row straight through the break — the one way to get a straddling stored row.

describe('a dropped row never straddles the lunch break', () => {
  it('cuts a 6 h drop onto a frozen past Monday into 10:00-14:00 and 15:30-17:30', () => {
    const composeInput = input({
      today: WED,
      blocks: [block({ id: 'soltado', project: 'historial', date: MON, from: '10:00', hours: 6 })],
    });

    const resolved = expectPlaced(resolveManualPlacement(composeInput, dropOf('soltado')));

    expect(calendarRows(resolved.blocks)).toEqual([
      `${MON} 10:00-14:00 historial`,
      `${MON} 15:30-17:30 historial`,
    ]);
    // Net working minutes, so the six hours are all still there.
    expect(minutesByProject(resolved.blocks)).toEqual({ historial: 6 * 60 });
    expect(resolved.placedBlockId).toBe('soltado');
    // And the engine hands the frozen day straight back, segments and all.
    expect(rows(compose({ ...composeInput, blocks: resolved.blocks }))).toEqual(
      calendarRows(resolved.blocks),
    );
  });

  it('does the same on the weekend and on a movable weekday', () => {
    const onSaturday = input({
      today: MON,
      blocks: [block({ id: 'soltado', project: 'urgencia', date: SAT, from: '13:00', hours: 3 })],
    });
    expect(calendarRows(expectPlaced(resolveManualPlacement(onSaturday, dropOf('soltado'))).blocks)).toEqual([
      `${SAT} 13:00-14:00 urgencia`,
      `${SAT} 15:30-17:30 urgencia`,
    ]);

    const onThursday = input({
      today: MON,
      blocks: [block({ id: 'soltado', project: 'porton', date: THU, from: '13:00', hours: 3 })],
    });
    expect(calendarRows(expectPlaced(resolveManualPlacement(onThursday, dropOf('soltado'))).blocks)).toEqual([
      `${THU} 13:00-14:00 porton`,
      `${THU} 15:30-17:30 porton`,
    ]);
  });

  it('resolving the same drop again changes nothing — the segments do not overlap', () => {
    const composeInput = input({
      today: WED,
      blocks: [block({ id: 'soltado', project: 'historial', date: MON, from: '10:00', hours: 6 })],
    });

    const once = expectPlaced(resolveManualPlacement(composeInput, dropOf('soltado')));
    const twice = expectPlaced(
      resolveManualPlacement({ ...composeInput, blocks: once.blocks }, dropOf('soltado')),
    );

    expect(calendarRows(twice.blocks)).toEqual(calendarRows(once.blocks));
    expect(twice.mergedBlockIds).toEqual([]);
  });

  it('segments a MERGE that ends up crossing the break, instead of storing one long row', () => {
    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'ya-estaba', project: 'urgencia', date: SAT, from: '12:00', hours: 2 }),
        block({ id: 'soltado', project: 'urgencia', date: SAT, from: '13:00', hours: 2 }),
      ],
    });

    const resolved = expectPlaced(resolveManualPlacement(composeInput, dropOf('soltado')));

    // 12:00 + the SUM of 4 h, then cut at the break: no hour is lost and no row straddles.
    expect(calendarRows(resolved.blocks)).toEqual([
      `${SAT} 12:00-14:00 urgencia`,
      `${SAT} 15:30-17:30 urgencia`,
    ]);
    expect(minutesByProject(resolved.blocks)).toEqual({ urgencia: 4 * 60 });
    // The absorbed row's id is reused for the second segment rather than deleted and re-inserted.
    expect(resolved.mergedBlockIds).toEqual([]);
    expect(sortedIds(resolved.blocks)).toEqual(['ya-estaba', 'soltado']);
  });

  it('leaves a drop into the visual margins exactly as it was made', () => {
    // Margins are outside the ruler and take a hand drop as-is: no boundary inside to cut at.
    const composeInput = input({
      today: MON,
      blocks: [block({ id: 'soltado', project: 'urgencia', date: SAT, from: '19:00', hours: 2 })],
    });

    expect(calendarRows(expectPlaced(resolveManualPlacement(composeInput, dropOf('soltado'))).blocks)).toEqual([
      `${SAT} 19:00-21:00 urgencia`,
    ]);
  });

  it('has nothing to cut when the shift has no break', () => {
    const composeInput = input({
      today: MON,
      shape: withWindows({ ...SHAPE, periods: [{ startMinutes: t('08:00'), endMinutes: t('18:00') }] }),
      blocks: [block({ id: 'soltado', project: 'urgencia', date: SAT, from: '10:00', hours: 6 })],
    });

    expect(calendarRows(expectPlaced(resolveManualPlacement(composeInput, dropOf('soltado'))).blocks)).toEqual([
      `${SAT} 10:00-16:00 urgencia`,
    ]);
  });

  it('cuts the tail it pushes at the break as well, so neither piece straddles', () => {
    const composeInput = input({
      today: MON,
      blocks: [
        block({ id: 'a', project: 'barandilla', date: SAT, from: '09:00', hours: 2 }),
        block({ id: 'b', project: 'porton', date: SAT, from: '10:00', hours: 5 }),
      ],
    });

    const resolved = expectPlaced(resolveManualPlacement(composeInput, dropOf('b')));

    expect(calendarRows(resolved.blocks)).toEqual([
      `${SAT} 09:00-10:00 barandilla`,
      `${SAT} 10:00-14:00 porton`,
      `${SAT} 15:30-16:30 porton`,
      `${SAT} 16:30-17:30 barandilla`,
    ]);
    expect(minutesByProject(resolved.blocks)).toEqual({ barandilla: 2 * 60, porton: 5 * 60 });
  });
});

// ---------------------------------------------------------------------------
// The summary strip's arithmetic
// ---------------------------------------------------------------------------

describe('the summary strip is arithmetic, not wording', () => {
  it('reports the last occupied day, the hours still queued and the state of the buffer', () => {
    const summary = summarizeSchedule(
      [
        block({ project: 'historial', date: LAST_FRI, from: '08:00', hours: 6 }),
        block({ project: 'escalera', date: TUE, from: '08:00', hours: 6 }),
        block({ project: 'porton', date: THU, from: '08:00', hours: 4 }),
      ],
      MON,
    );

    // The past is done, so it is not queued.
    expect(summary.queuedMinutes).toBe(10 * 60);
    expect(summary.lastOccupiedDate).toBe(THU);
    expect(summary.bufferDate).toBe(FRI);
    expect(summary.bufferClear).toBe(true);
  });

  it('sees the buffer as taken as soon as anything sits on it', () => {
    const summary = summarizeSchedule([block({ project: 'porton', date: FRI, from: '08:00', hours: 2 })], MON);
    expect(summary.bufferClear).toBe(false);
    expect(summary.lastOccupiedDate).toBe(FRI);
  });

  it('talks about next week once this Friday is behind us', () => {
    expect(summarizeSchedule([], SAT).bufferDate).toBe('2026-08-21');
    expect(summarizeSchedule([], FRI).bufferDate).toBe(FRI);
    expect(summarizeSchedule([], SUN).bufferDate).toBe('2026-08-21');
  });

  it('has nothing to report about an empty calendar', () => {
    expect(summarizeSchedule([], MON)).toEqual({
      lastOccupiedDate: null,
      queuedMinutes: 0,
      bufferDate: FRI,
      bufferClear: true,
    });
  });
});

// ---------------------------------------------------------------------------
// The rules as properties, over generated calendars
// ---------------------------------------------------------------------------
//
// Calendars from a seeded generator, including deliberately impossible rows (a block straddling
// lunch, two locked blocks on top of each other), so the engine is never trusted to have been handed
// tidy data. The grouping drift and the buffer slipping onto Friday were both found here first, by
// the idempotence property. The seed is printed with every failure.

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = Math.imul(state ^ (state >>> 15), 1 | state);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const GENERATED_DAYS = [LAST_FRI, MON, TUE, WED, THU, FRI, SAT, SUN, NEXT_MON, '2026-08-18', '2026-08-19'];
const GENERATED_PROJECTS = ['escalera', 'porton', 'barandilla', 'nuevo'];

const MORNING_ONLY: DayShape = withWindows({
  periods: [{ startMinutes: t('08:00'), endMinutes: t('14:00') }],
  shiftMinutes: 360,
  capacityMinutes: 360,
  marginTopMinutes: 60,
  marginBottomMinutes: 60,
  timelineStartMinutes: t('07:00'),
  timelineEndMinutes: t('15:00'),
});

const NO_LUNCH: DayShape = withWindows({
  ...SHAPE,
  periods: [
    { startMinutes: t('08:00'), endMinutes: t('14:00') },
    { startMinutes: t('14:00'), endMinutes: t('18:00') },
  ],
});

function generateInput(seed: number): ComposeInput {
  const random = seededRandom(seed);
  const pick = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length)];
  /**
   * MINUTES OFF THE QUARTER HOUR, on a quarter of the calendars. Nothing a gesture asks for is off
   * the grid, but a deleted sub-quarter row takes those minutes off a job's total — and once a day
   * can take PART of an item, off-grid quantities are where the quarter-hour floor is at risk. They
   * also produce five- and ten-minute runs, the holes `takeableFrom` must step over.
   */
  const skew = (): number => (random() < 0.25 ? pick([5, 10, 20, 25]) : 0);

  const blocks: Block[] = [];
  for (let count = 1 + Math.floor(random() * 7); count > 0; count -= 1) {
    blocks.push(
      block({
        project: pick(GENERATED_PROJECTS),
        date: pick(GENERATED_DAYS),
        from: minutesToHHmm(t('08:00') + Math.floor(random() * 20) * 30 + skew()),
        hours: (30 + Math.floor(random() * 8) * 30 + skew()) / 60,
        // The padlock, however it was set: the engine may never move this row, and it must come
        // back untouched.
        locked: random() < 0.25,
      }),
    );
  }

  const gaps: Gap[] = [];
  for (let count = Math.floor(random() * 3); count > 0; count -= 1) {
    gaps.push(
      gap({
        date: pick(GENERATED_DAYS),
        from: minutesToHHmm(t('08:00') + Math.floor(random() * 20) * 30 + skew()),
        hours: (30 + Math.floor(random() * 4) * 30 + skew()) / 60,
      }),
    );
  }

  const overrides: DayOverride[] = [];
  if (random() < 0.3) overrides.push(closedDay(pick(GENERATED_DAYS)));
  if (random() < 0.3) overrides.push(dayCapacity(pick(GENERATED_DAYS), 1 + Math.floor(random() * 9)));

  const base = pick([SHAPE, SHAPE, SHAPE, MORNING_ONLY, NO_LUNCH]);
  return input({
    today: pick([MON, TUE, WED, THU, FRI]),
    blocks,
    gaps,
    shape: { ...base, capacityMinutes: Math.min(base.shiftMinutes, pick([240, 360, 480, 600])) },
    overrides,
    horizonWeeks: pick([1, 2, 8]),
    newProjectIds: random() < 0.5 ? ['nuevo'] : undefined,
    grownProjectIds: random() < 0.4 ? [pick(GENERATED_PROJECTS)] : undefined,
  });
}

/** The union of the day's periods: contiguous periods are one solid stretch. */
function periodUnion(composeInput: ComposeInput, date: string): { start: number; end: number }[] {
  const union: { start: number; end: number }[] = [];
  for (const period of composeInput.getDayConfig(date).periods) {
    const last = union[union.length - 1];
    if (last !== undefined && period.startMinutes <= last.end) {
      last.end = Math.max(last.end, period.endMinutes);
      continue;
    }
    union.push({ start: period.startMinutes, end: period.endMinutes });
  }
  return union;
}

/**
 * The rows a resolution PLACED: the drop's own rows, whatever their id after a merge, and every row
 * it created. Deliberately not the head of a row the cut merely SHORTENED — that is somebody else's
 * pre-existing row, and repairing it would be tidying the weekend rule forbids.
 */
function rowsPlaced(
  composeInput: ComposeInput,
  result: ManualPlacementSuccess,
  projectId: string,
): Block[] {
  const geometry = (row: { date: string; startMinutes: number; durationMinutes: number }): string =>
    `${row.date} ${row.startMinutes} ${row.durationMinutes}`;
  const before = new Map(composeInput.blocks.map((row) => [row.id, geometry(row)]));
  return result.blocks.filter(
    (row) =>
      row.id === result.placedBlockId ||
      !before.has(row.id) ||
      (row.projectId === projectId && before.get(row.id) !== geometry(row)),
  );
}

/** True when some job's placed rows sit on more than one date: hours that overflowed a day. */
function spansTwoDays(placed: readonly PlacedBlock[]): boolean {
  const dates = new Map<string, Set<string>>();
  for (const row of placed) {
    const own = dates.get(row.projectId) ?? new Set<string>();
    own.add(row.date);
    dates.set(row.projectId, own);
  }
  return [...dates.values()].some((own) => own.size > 1);
}

function straddlesABreak(
  composeInput: ComposeInput,
  row: { date: string; startMinutes: number; durationMinutes: number },
): boolean {
  const union = periodUnion(composeInput, row.date);
  const end = row.startMinutes + row.durationMinutes;
  return union.some((period, index) => {
    const next = union[index + 1];
    if (next === undefined) return false;
    // Minutes on BOTH sides of the hole.
    if (row.startMinutes < period.end && end > next.start) return true;
    // Or a start INSIDE the hole, running out of it: no period covers 14:00, so the test above said
    // nothing about `14:00 +120m -> 16:00` holding ninety minutes of lunch.
    return row.startMinutes >= period.end && row.startMinutes < next.start && end > next.start;
  });
}

describe('the rules hold over generated calendars', () => {
  it('places 2000 of them without breaking one invariant', () => {
    for (let seed = 1; seed <= 2000; seed += 1) {
      sequence = 0;
      const composeInput = generateInput(seed);
      const result = compose(composeInput);
      if (!result.ok) {
        // The only permitted failure, and it must carry no placement to undo.
        expect(result.error.code, `seed ${seed}`).toBe('horizon-exceeded');
        expect('blocks' in result, `seed ${seed}`).toBe(false);
        continue;
      }
      const where = `seed ${seed}`;

      // Rule 15 — hours are moved, never created or lost.
      expect(minutesByProject(result.blocks), `${where}: minutes not conserved`).toEqual(
        minutesByProject(composeInput.blocks),
      );

      // Every input row is either kept or reported deleted, exactly once.
      const kept = result.blocks.map((placed) => placed.id).filter((id): id is string => id !== null);
      const accounted = [...kept, ...result.deletedBlockIds].sort();
      expect(accounted, `${where}: a row went missing`).toEqual(
        composeInput.blocks.map((candidate) => candidate.id).sort(),
      );
      expect(new Set(accounted).size, `${where}: a row was both kept and deleted`).toBe(accounted.length);

      const fixed = composeInput.blocks.filter((candidate) => !isMovable(candidate, composeInput.today));
      const isFixed = (id: string | null): boolean => fixed.some((candidate) => candidate.id === id);

      // Rules 2, 6 and 10 — everything outside the pool comes back untouched.
      for (const before of fixed) {
        const after = result.blocks.find((placed) => placed.id === before.id);
        expect(after, `${where}: fixed row ${before.id} vanished`).toBeDefined();
        expect(
          `${after?.date} ${after?.startMinutes} ${after?.durationMinutes} ${after?.locked}`,
          `${where}: fixed row ${before.id} moved`,
        ).toBe(`${before.date} ${before.startMinutes} ${before.durationMinutes} ${before.locked}`);
      }

      for (const placed of result.blocks) {
        expect(placed.durationMinutes, `${where}: an empty row`).toBeGreaterThan(0);
        if (isFixed(placed.id)) continue;
        // Rule 10 — the past is frozen. Rule 6 — the weekend is never auto-placed.
        expect(compareDates(placed.date, composeInput.today) >= 0, `${where}: wrote to the past`).toBe(true);
        expect(isWeekend(placed.date), `${where}: wrote to the weekend`).toBe(false);
        // Rule 11 and the visual margins — inside the working periods, always.
        const end = placed.startMinutes + placed.durationMinutes;
        expect(
          periodUnion(composeInput, placed.date).some(
            (period) => placed.startMinutes >= period.start && end <= period.end,
          ),
          `${where}: ${describeBlock(placed)} is outside the working periods`,
        ).toBe(true);
      }

      // Nothing the engine placed overlaps anything else (two fixed rows may
      // overlap each other — that is impossible input, not a placement).
      const byDate = new Map<string, PlacedBlock[]>();
      for (const placed of result.blocks) {
        byDate.set(placed.date, [...(byDate.get(placed.date) ?? []), placed]);
      }
      for (const [date, list] of byDate) {
        const ordered = [...list].sort((a, b) => a.startMinutes - b.startMinutes);
        for (let index = 1; index < ordered.length; index += 1) {
          if (isFixed(ordered[index].id) && isFixed(ordered[index - 1].id)) continue;
          expect(
            ordered[index].startMinutes >= ordered[index - 1].startMinutes + ordered[index - 1].durationMinutes,
            `${where}: two rows overlap on ${date}`,
          ).toBe(true);
        }
      }

      // Rule 4 — gaps are occupied time, so nothing is planned on top of one.
      for (const placed of result.blocks) {
        if (isFixed(placed.id)) continue;
        for (const hole of composeInput.gaps) {
          if (hole.date !== placed.date) continue;
          const overlap =
            Math.min(placed.startMinutes + placed.durationMinutes, hole.startMinutes + hole.durationMinutes) -
            Math.max(placed.startMinutes, hole.startMinutes);
          expect(overlap <= 0, `${where}: planned over a gap on ${placed.date}`).toBe(true);
        }
      }

      /*
       * INVARIANT 4 — NO ROW SHORTER THAN A QUARTER OF AN HOUR, the sharp edge of *fill and
       * overflow*. An implication rather than a flat ban: with fewer than two rows' worth left there
       * is no split that avoids a short row, and drawing it beats refusing to place it.
       */
      const slivers = result.blocks.filter(
        (placed) => !isFixed(placed.id) && placed.durationMinutes < MIN_ROW_MINUTES,
      );
      if (slivers.length > 0) {
        expect(
          buildQueue(composeInput).some((item) => item.durationMinutes < 2 * MIN_ROW_MINUTES),
          `${where}: ${slivers.map(describeBlock).join(', ')} — a sliver from an item big enough to split cleanly`,
        ).toBe(true);
      }

      // Rule 4 — auto-filled minutes never exceed the day's stop line.
      for (const [date, list] of byDate) {
        const planned = list
          .filter((placed) => !isFixed(placed.id))
          .reduce((total, placed) => total + placed.durationMinutes, 0);
        if (planned === 0) continue;
        expect(planned <= plannableMinutes(composeInput, date), `${where}: over the stop line on ${date}`).toBe(
          true,
        );
      }

      // Rule 5 — the buffer holds grown work, or work that was already on it.
      const grown = new Set(composeInput.grownProjectIds ?? []);
      const alreadyOnBuffer = new Set(
        composeInput.blocks
          .filter((candidate) => isMovable(candidate, composeInput.today))
          .map((candidate) => `${candidate.projectId}|${candidate.date}`),
      );
      for (const placed of result.blocks) {
        if (isFixed(placed.id)) continue;
        if (composeInput.getDayConfig(placed.date).role !== 'buffer') continue;
        expect(
          grown.has(placed.projectId) || alreadyOnBuffer.has(`${placed.projectId}|${placed.date}`),
          `${where}: ${placed.projectId} took the buffer on ${placed.date} without growing`,
        ).toBe(true);
      }

      const queue = buildQueue(composeInput);

      // Rule 5, the other half — a padlocked row is never recovered, wherever it sits. `fixed` above
      // pins its date, slot and length; what is left is that it never joins the queue or loses the mark.
      for (const before of composeInput.blocks.filter((candidate) => candidate.locked)) {
        expect(
          queue.some((item) => item.blockIds.includes(before.id)),
          `${where}: a padlocked row was queued for reflow`,
        ).toBe(false);
        expect(
          result.blocks.find((placed) => placed.id === before.id)?.locked,
          `${where}: a padlocked row lost its padlock`,
        ).toBe(true);
      }

      // Rule 9 — strict order: the queue's projects come out in the queue's order, on EVERY seed and
      // with no exemption.
      const collapse = (projects: readonly string[]): string[] =>
        projects.filter((project, index) => project !== projects[index - 1]);
      expect(
        collapse(result.blocks.filter((placed) => !isFixed(placed.id)).map((placed) => placed.projectId)),
        `${where}: the queue order was not preserved`,
      ).toEqual(collapse(queue.map((item) => item.projectId)));

      // The engine settles: this pass, and the ordinary save that follows it.
      expectSettled(composeInput, result, where);
    }
  });

  it('generates the padlocked rows and the split work these properties are about', () => {
    // A guard on the GENERATOR, not the engine: if it stopped producing padlocked rows or work that
    // spans two days, everything above would still be green and would prove nothing about them.
    let withLocked = 0;
    let withSplit = 0;
    for (let seed = 1; seed <= 2000; seed += 1) {
      sequence = 0;
      const composeInput = generateInput(seed);
      if (composeInput.blocks.some((candidate) => candidate.locked)) withLocked += 1;
      // A calendar where some item's hours must land on more than one DAY: the shape *fill and
      // overflow* made ordinary, and what every property above is really about.
      const result = compose(composeInput);
      if (result.ok && spansTwoDays(result.blocks)) withSplit += 1;
    }
    expect(withLocked, 'the generator stopped producing padlocked rows').toBeGreaterThan(300);
    expect(withSplit, 'the generator stopped producing work split across days').toBeGreaterThan(100);
  });
});

describe('manual placement holds over the same generated calendars', () => {
  // The generator produces impossible input on purpose, which is the state a drop has to survive. The
  // property that matters is that the resolution is a FIXED POINT: resolving the same drop twice
  // changes nothing, which is how to say "no overlap was left" without restating the algorithm.
  it('resolves a drop on every generated calendar without losing an hour', () => {
    let resolvedCount = 0;
    let mergedCount = 0;
    let displacedCount = 0;

    for (let seed = 1; seed <= 2000; seed += 1) {
      sequence = 0;
      tailSequence = 0;
      const composeInput = generateInput(seed);
      const fixed = composeInput.blocks.filter((candidate) => !isMovable(candidate, composeInput.today));
      if (fixed.length === 0) continue;

      const where = `seed ${seed}`;
      const dropped = fixed[seed % fixed.length];
      const result = resolveManualPlacement(composeInput, dropOf(dropped.id));

      if (!result.ok) {
        // The four refusals, all of which write nothing: a lock in the way, a GAP in the
        // way, a merge the day cannot hold, and hours with nowhere left inside the horizon.
        expect(
          ['overlaps-locked-block', 'overlaps-gap', 'merge-exceeds-day', 'displaced-hours-unplaceable'],
          `${where}: ${result.error.code}`,
        ).toContain(result.error.code);
        continue;
      }
      resolvedCount += 1;
      if (result.mergedBlockIds.length > 0) mergedCount += 1;
      if (result.displacedProjectIds.length > 0) displacedCount += 1;

      // The invariant, first and last: hours are moved, never created or lost.
      expect(minutesByProject(result.blocks), `${where}: minutes not conserved`).toEqual(
        minutesByProject(composeInput.blocks),
      );

      for (const row of result.blocks) {
        expect(row.durationMinutes, `${where}: an empty row`).toBeGreaterThan(0);
        expect(row.startMinutes + row.durationMinutes, `${where}: a row past midnight`).toBeLessThanOrEqual(
          24 * 60,
        );
      }

      // The drop is stored in SEGMENTS: no row the resolution WROTE holds minutes on both sides of the
      // break. Rows it left alone are out of scope — repairing one nobody touched is tidying.
      for (const row of rowsPlaced(composeInput, result, dropped.projectId)) {
        expect(straddlesABreak(composeInput, row), `${where}: a placed row straddles the break`).toBe(
          false,
        );
      }

      // Rows the resolution CREATED answer for different things. A DISPLACED TAIL was placed: inside
      // one working period, touching nothing, because nothing will move it afterwards. A SEGMENT OF
      // THE DROP only keeps the slot the owner chose, margins included, so an overlap is fine wherever
      // the REFLOW WILL REPAIR IT — which needs only one of the two rows to be movable. What may never
      // overlap is two rows BOTH outside the pool.
      const created = result.blocks.filter((row) => row.id.startsWith('cola-'));
      for (const row of created) {
        const isSegmentOfTheDrop = row.projectId === dropped.projectId;
        expect(
          isSegmentOfTheDrop ||
            periodUnion(composeInput, row.date).some(
              (period) =>
                row.startMinutes >= period.start && row.startMinutes + row.durationMinutes <= period.end,
            ),
          `${where}: displaced hours landed outside the working periods on ${row.date}`,
        ).toBe(true);
        for (const other of result.blocks) {
          if (other === row) continue;
          if (
            isSegmentOfTheDrop &&
            (isMovable(other, composeInput.today) || isMovable(row, composeInput.today))
          ) {
            continue;
          }
          expect(
            Math.min(
              row.startMinutes + row.durationMinutes,
              other.startMinutes + other.durationMinutes,
            ) - Math.max(row.startMinutes, other.startMinutes) <= 0 || other.date !== row.date,
            `${where}: a written row overlaps another on ${row.date}`,
          ).toBe(true);
        }
      }

      // THE FIXED POINT: nothing overlaps the drop, so a second pass has nothing to merge or cut.
      const again = expectPlaced(
        resolveManualPlacement({ ...composeInput, blocks: result.blocks }, dropOf(result.placedBlockId)),
      );
      expect(again.mergedBlockIds, `${where}: a second pass merged again`).toEqual([]);
      expect(again.displacedProjectIds, `${where}: a second pass displaced again`).toEqual([]);
      expect(calendarRows(again.blocks), `${where}: a second pass moved something`).toEqual(
        calendarRows(result.blocks),
      );

      // And the engine still settles on what it was handed.
      const placement = compose({ ...composeInput, blocks: result.blocks });
      if (!placement.ok) {
        expect(placement.error.code, where).toBe('horizon-exceeded');
        continue;
      }
      expectMinutesConserved({ ...composeInput, blocks: result.blocks }, placement);
      expectSettled({ ...composeInput, blocks: result.blocks }, placement);
    }

    // Guards on the GENERATOR: a property test that quietly stopped reaching the merge or the cut
    // would still be green, and the fixed point above would prove nothing.
    expect(resolvedCount, 'the generator stopped producing resolvable drops').toBeGreaterThan(500);
    expect(mergedCount, 'the generator stopped producing same-job overlaps').toBeGreaterThan(0);
    expect(displacedCount, 'the generator stopped producing other-job overlaps').toBeGreaterThan(0);
  });
});

describe('a drop the reflow WILL settle holds over the same generated calendars', () => {
  // The other side of the resolver, over the same impossible input. It writes ranks rather than
  // placements, so what holds is different: the drop is never touched, the hours are all there, the
  // cut is a fixed point, and the calendar it hands the engine settles in one pass.
  it('cuts, keeps every hour and settles, on every generated calendar', () => {
    let resolvedCount = 0;
    let cutCount = 0;

    for (let seed = 1; seed <= 2000; seed += 1) {
      sequence = 0;
      tailSequence = 0;
      const composeInput = generateInput(seed);
      const movable = composeInput.blocks.filter((candidate) => isMovable(candidate, composeInput.today));
      if (movable.length === 0) continue;

      const where = `seed ${seed}`;
      const dropped = movable[seed % movable.length];
      const result = resolveManualPlacement(composeInput, dropOf(dropped.id));

    // Nothing here to refuse: a lock is flowed around rather than cut, and no hours are placed.
      const resolved = expectPlaced(result);
      resolvedCount += 1;
      if (resolved.displacedProjectIds.length > 0) cutCount += 1;

      expect(resolved.placedBlockId, `${where}: the drop lost its row`).toBe(dropped.id);
      expect(resolved.mergedBlockIds, `${where}: a reflowed drop must never merge`).toEqual([]);
      expect(minutesByProject(resolved.blocks), `${where}: minutes not conserved`).toEqual(
        minutesByProject(composeInput.blocks),
      );

      // The dropped row keeps its slot; only what it landed in moves. Its LENGTH may be cut at the
      // break, so the hours are checked as a total over its segments. "The slot it was dropped in" is
      // the first WORKING minute of it, which has to be the same minute `segmentDroppedRow` uses or
      // the cut and the rank would be measured from two different places.
      const after = resolved.blocks.find((row) => row.id === dropped.id);
      const droppedStart = firstWorkingMinute(
        composeInput.getDayConfig(dropped.date).manualWindows,
        dropped.startMinutes,
      );
      expect(
        `${after?.date} ${after?.startMinutes} ${after?.locked}`,
        `${where}: the drop itself was moved`,
      ).toBe(`${dropped.date} ${droppedStart} ${dropped.locked}`);
      // Only the DROP's own rows: on this side a cut victim's tail is a queue RANK carrying the tail's
      // hours, so it may read `13:30 + 150 min` across the break. `compose` re-lays it out and cuts
      // it, which `expectSettled` below proves; the resolver's output only reaches the table that way.
      for (const row of rowsPlaced(composeInput, resolved, dropped.projectId)) {
        if (row.projectId !== dropped.projectId) continue;
        expect(straddlesABreak(composeInput, row), `${where}: a placed row straddles the break`).toBe(
          false,
        );
      }

      // A locked row is never cut, whatever the drop lands on.
      for (const before of composeInput.blocks.filter((row) => row.locked)) {
        const still = resolved.blocks.find((row) => row.id === before.id);
        expect(
          `${still?.date} ${still?.startMinutes} ${still?.durationMinutes}`,
          `${where}: a locked row was cut`,
        ).toBe(`${before.date} ${before.startMinutes} ${before.durationMinutes}`);
      }

      // THE FIXED POINT. Nothing starts before the drop and runs into it any more.
      const again = expectPlaced(
        resolveManualPlacement({ ...composeInput, blocks: resolved.blocks }, dropOf(dropped.id)),
      );
      expect(again.displacedProjectIds, `${where}: a second pass cut again`).toEqual([]);
      expect(calendarRows(again.blocks), `${where}: a second pass moved something`).toEqual(
        calendarRows(resolved.blocks),
      );

      // And the engine settles on what it was handed, in one pass.
      const placement = compose({ ...composeInput, blocks: resolved.blocks });
      if (!placement.ok) {
        expect(placement.error.code, where).toBe('horizon-exceeded');
        continue;
      }
      expectMinutesConserved({ ...composeInput, blocks: resolved.blocks }, placement);
      expectSettled({ ...composeInput, blocks: resolved.blocks }, placement, where);
    }

    // Guards on the GENERATOR: without a drop that lands inside another job's row, this proves nothing.
    expect(resolvedCount, 'the generator stopped producing movable drops').toBeGreaterThan(500);
    expect(cutCount, 'the generator stopped producing movable overlaps').toBeGreaterThan(0);
  });
});

describe("editing a job's hours holds over the same generated calendars", () => {
    // Stated over the ROWS rather than the placement, because that is where the damage was: hours
    // written onto a row nothing would ever settle, drawn as a rectangle that lied about the day.
  const HOURS = [30, 60, 150, 8 * 60];

  it('never grows a row outside the movable pool, and never overruns a day', () => {
    let grewCount = 0;
    let createdCount = 0;
    let shrankCount = 0;

    for (let seed = 1; seed <= 2000; seed += 1) {
      sequence = 0;
      const composeInput = generateInput(seed);
      const projects = [...new Set(composeInput.blocks.map((row) => row.projectId))];
      if (projects.length === 0) continue;

      const where = `seed ${seed}`;
      const projectId = projects[seed % projects.length];
      const own = composeInput.blocks.filter((row) => row.projectId === projectId);
      const fixed = own.filter((row) => !isMovable(row, composeInput.today));
      const change = {
        projectId,
        today: composeInput.today,
        newBlockId: 'nueva',
        now: '2026-08-12 09:00:00',
      };

      // ADDING hours. Every row outside the pool must come back at exactly the length it
      // went in with; the delta is either on a movable row or on a row of its own.
      const added = expectEdited(
        changeProjectMinutes(composeInput.blocks, { ...change, deltaMinutes: HOURS[seed % HOURS.length] }),
      );
      grewCount += 1;
      for (const before of fixed) {
        expect(
          added.blocks.find((row) => row.id === before.id)?.durationMinutes,
          `${where}: grew ${before.id}, which the engine cannot settle`,
        ).toBe(before.durationMinutes);
      }
      expect(minutesByProject(added.blocks)[projectId], `${where}: the delta went missing`).toBe(
        minutesByProject(own)[projectId] + HOURS[seed % HOURS.length],
      );
      if (added.blocks.some((row) => row.id === 'nueva')) createdCount += 1;

      // A row the engine will NOT re-place has to be inside its day already, because the draft's own
      // numbers are what get stored. For a movable row the start is a queue RANK, not a position, so
      // the bound is asserted twice, on the two different things it means.
      for (const row of added.blocks.filter((candidate) => !isMovable(candidate, composeInput.today))) {
        expect(
          row.startMinutes + row.durationMinutes,
          `${where}: ${row.id} runs past the end of ${row.date} and nothing will move it`,
        ).toBeLessThanOrEqual(MINUTES_PER_DAY);
      }

      // ...and the engine settles it once, with every PLACED row inside its day.
      const placement = compose({ ...composeInput, blocks: added.blocks, grownProjectIds: [projectId] });
      if (placement.ok) {
        for (const placed of placement.blocks) {
          expect(
            placed.startMinutes + placed.durationMinutes,
            `${where}: ${describeBlock(placed)} runs past the end of the day`,
          ).toBeLessThanOrEqual(MINUTES_PER_DAY);
        }
        expectMinutesConserved({ ...composeInput, blocks: added.blocks }, placement);
        expectSettled({ ...composeInput, blocks: added.blocks }, placement, where);
      } else {
        expect(placement.error.code, where).toBe('horizon-exceeded');
      }

      // REMOVING hours must still reach every row: shrinking frees space rather than claiming it.
      const total = minutesByProject(own)[projectId];
      const removal = Math.min(total, HOURS[(seed + 1) % HOURS.length]);
      const removed = changeProjectMinutes(composeInput.blocks, { ...change, deltaMinutes: -removal });
      if (removal === total) {
        // The job would be left with no hours at all; the transform empties every row.
        expectEdited(removed);
        continue;
      }
      const shrunk = expectEdited(removed);
      shrankCount += 1;
      expect(minutesByProject(shrunk.blocks)[projectId], `${where}: the removal did not land`).toBe(
        total - removal,
      );
      expect(shrunk.blocks.every((row) => row.durationMinutes > 0), `${where}: an empty row survived`).toBe(
        true,
      );
    }

    // Guards on the GENERATOR: the point is the rows the engine cannot settle, so if it stopped
    // producing them the property above would be green and would prove nothing.
    expect(grewCount, 'the generator stopped producing jobs to grow').toBeGreaterThan(1000);
    expect(createdCount, 'no job ever needed a row of its own').toBeGreaterThan(100);
    expect(shrankCount, 'the generator stopped producing jobs to shrink').toBeGreaterThan(500);
  });
});

describe('shrinking a row holds over the same generated calendars', () => {
  /**
   * A shrink has two answers, a transfer or a QUESTION, and both are stated as arithmetic: hours
   * conserved against the total the caller is told to write, and a refusal that is always answerable.
   */
  it('either transfers the hours or asks, and every answer it offers works', () => {
    let transferred = 0;
    let asked = 0;
    let automatic = 0;

    for (let seed = 1; seed <= 2000; seed += 1) {
      sequence = 0;
      tailSequence = 0;
      const composeInput = generateInput(seed);
      const target = composeInput.blocks[seed % composeInput.blocks.length];
      // Half the row, on the quarter hour: the resolution every gesture in the app has.
      const next = Math.max(MIN_ROW_MINUTES, Math.round(target.durationMinutes / 30) * 15);
      if (next >= target.durationMinutes) continue;

      const where = `seed ${seed} shrinking ${target.id} to ${next}`;
      const day = composeInput.getDayConfig(target.date);
      const before = minutesByProject(composeInput.blocks)[target.projectId];
      const shrink = (freedHours?: FreedHoursChoice): EditResult =>
        resizeBlock(composeInput.blocks, {
          blockId: target.id,
          durationMinutes: next,
          today: composeInput.today,
          day: { periods: day.periods, manualWindows: day.manualWindows },
          freedHours,
          newBlockId: () => `resize-${++tailSequence}`,
          now: '2026-08-12 09:00:00',
        });

      const asIs = shrink();

      // ON A ROW THE ENGINE LAYS OUT, shrinking always ASKS and the only answer is to take the hours
      // off the job. `new-block` may never appear there: a row of its own, of this same job and
      // unpinned, is placed straight back where these hours already were. Asserted on every seed,
      // then dropped into the generic path below, which checks the answer really works.
      if (isMovable(target, composeInput.today)) {
        automatic += 1;
        expect(asIs.ok, where).toBe(false);
        if (!asIs.ok) {
          expect(asIs.error.code, where).toBe('shrink-needs-choice');
          expect(asIs.error.choices, where).toEqual(['reduce-total']);
        }
      }

      if (!asIs.ok) {
        // The only refusal a shrink may produce, and it must carry the hours and a way out.
        asked += 1;
        expect(asIs.error.code, where).toBe('shrink-needs-choice');
        expect(asIs.error.freedMinutes, where).toBeGreaterThan(0);
        expect(asIs.error.choices?.length, where).toBeGreaterThan(0);

        for (const choice of asIs.error.choices ?? []) {
          const answered = expectEdited(shrink(choice));
          const expectedDelta = choice === 'reduce-total' ? -(asIs.error.freedMinutes ?? 0) : 0;
          expect(answered.totalMinutesDelta, `${where}: ${choice} moved the total wrongly`).toBe(
            expectedDelta,
          );
          expect(
            minutesByProject(answered.blocks)[target.projectId] ?? 0,
            `${where}: ${choice} lost or invented hours`,
          ).toBe(before + expectedDelta);
          expectPlaceable(composeInput, answered, `${where}: ${choice}`);
        }
        continue;
      }

      // A transfer inside the job: the total never moves, and the hours are all still there.
      transferred += 1;
      expect(asIs.totalMinutesDelta, `${where}: a transfer changed the total`).toBe(0);
      expect(minutesByProject(asIs.blocks)[target.projectId], `${where}: hours went missing`).toBe(before);
      // Nobody else's rows were touched — a resize is an edit INSIDE one job.
      for (const row of composeInput.blocks.filter((other) => other.projectId !== target.projectId)) {
        const after = asIs.blocks.find((candidate) => candidate.id === row.id);
        expect(after?.durationMinutes, `${where}: ${row.id} belongs to another job`).toBe(
          row.durationMinutes,
        );
      }
      expectPlaceable(composeInput, asIs, where);
    }

    // Guards on the generator: both halves of the rule have to be reached.
    expect(transferred, 'no shrink ever found a counterparty').toBeGreaterThan(100);
    expect(asked, 'no shrink ever reached the dead end').toBeGreaterThan(100);
    expect(automatic, 'no shrink ever aimed at a row the engine lays out').toBeGreaterThan(200);
  });

  /** The engine settles what an edit produced, with every row inside its day, and settles it once. */
  function expectPlaceable(composeInput: ComposeInput, edit: EditSuccess, where: string): void {
    const placement = compose({ ...composeInput, blocks: edit.blocks, grownProjectIds: undefined });
    if (!placement.ok) {
      expect(placement.error.code, where).toBe('horizon-exceeded');
      return;
    }
    for (const placed of placement.blocks) {
      expect(
        placed.startMinutes + placed.durationMinutes,
        `${where}: ${describeBlock(placed)} runs past the end of the day`,
      ).toBeLessThanOrEqual(MINUTES_PER_DAY);
    }
    expectMinutesConserved({ ...composeInput, blocks: edit.blocks }, placement);
    expectSettled({ ...composeInput, blocks: edit.blocks }, placement, where);
  }
});

describe('creating a job with no blocks yet', () => {
  it('appends the hours after the last block on the calendar', () => {
    const existing = [
      block({ id: 'otro', project: 'porton', date: TUE, from: '08:00', hours: 2 }),
      block({ id: 'ultimo', project: 'barandilla', date: WED, from: '09:00', hours: 3 }),
    ];

    const edit = expectEdited(
      changeProjectMinutes(existing, {
        projectId: 'escalera',
        deltaMinutes: 240,
        today: MON,
        newBlockId: 'nueva',
        now: '2026-08-10 09:00:00',
      }),
    );

    // Creation order sets the initial queue position: after everything already there.
    expect(jobRows(edit.blocks, 'escalera')).toEqual([`${WED} 12:00-16:00`]);
    expect(edit.totalMinutesDelta).toBe(240);

    const composeInput = input({ today: MON, blocks: edit.blocks, newProjectIds: ['escalera'] });
    expect(rows(compose(composeInput))).toEqual([
      `${MON} 08:00-10:00 porton`,
      `${MON} 10:00-13:00 barandilla`,
      `${MON} 13:00-14:00 escalera`,
      `${MON} 15:30-18:30 escalera`,
    ]);
  });

  it('starts at today when the calendar is empty, and never on a weekend', () => {
    const fromNothing = expectEdited(
      changeProjectMinutes([], {
        projectId: 'escalera',
        deltaMinutes: 120,
        today: MON,
        newBlockId: 'nueva',
        now: '2026-08-10 09:00:00',
      }),
    );
    expect(fromNothing.blocks).toHaveLength(1);
    expect(fromNothing.blocks[0].date).toBe(MON);

    // A created row must land in the movable pool, or the engine could never place it.
    const onSaturday = expectEdited(
      changeProjectMinutes([], {
        projectId: 'escalera',
        deltaMinutes: 120,
        today: SAT,
        newBlockId: 'nueva',
        now: '2026-08-15 09:00:00',
      }),
    );
    expect(onSaturday.blocks[0].date).toBe(NEXT_MON);
  });
});

describe('the horizon is a wall in both directions — a sharp edge worth knowing', () => {
  it('fails the whole recomposition when existing work no longer fits inside it', () => {
    // Two rules meeting, and the one failure mode a caller has to design for: the movable pool includes
    // work parked beyond the horizon, while auto-placement may not write past it. So a backlog longer
    // than `planningHorizonWeeks` cannot be recomposed at all — and since every mutating operation
    // recomposes, even DELETING a job fails until it is widened. The UI must surface `horizonEndDate`
    // and point at Settings rather than swallow the error.
    const composeInput = input({
      today: MON,
      shape: withCapacity(4),
      horizonWeeks: 1,
      blocks: [
        block({ project: 'lleno', date: MON, from: '08:00', hours: 20 }),
        block({ project: 'lejano', date: '2026-12-01', from: '10:00', hours: 4 }),
      ],
      grownProjectIds: ['lleno'],
    });

    const result = compose(composeInput);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('the horizon must be enforced');
    expect(result.error.projectId).toBe('lejano');
    expect(result.error.horizonEndDate).toBe(SUN);

    // Widening the horizon is the way out, and it is a Settings change.
    expect(compose({ ...composeInput, planningHorizonWeeks: 8 }).ok).toBe(true);
  });
});
