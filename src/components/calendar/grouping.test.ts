/**
 * The visual unit: what a run contains, and what the group rolls up.
 *
 * A unit is one gesture on screen but several rows in the database. There is one fact left
 * to roll up — the PADLOCK — and it is a yes/no question about the whole unit, so `locked`
 * is a boolean. It carried a second list until 2026-08-18 (`manualBlockIds`, the rows whose
 * length the owner had drawn, which was exactly what *back to automatic* sent); that mark is
 * gone and the padlock is what fixes a length now.
 */

import { describe, expect, it } from 'vitest';
import { buildRuns, groupBlocks, segmentsOf, type BlockRun } from './grouping';
import type { WeekBlock } from '../../lib/api-client';

const PERIODS = [
  { startMinutes: 8 * 60, endMinutes: 14 * 60 },
  { startMinutes: 15 * 60 + 30, endMinutes: 19 * 60 + 30 },
];

function block(overrides: Partial<WeekBlock> & { id: string }): WeekBlock {
  return {
    projectId: 'barandilla',
    date: '2026-08-12',
    startMinutes: 8 * 60,
    durationMinutes: 60,
    locked: false,
    createdAt: '2026-08-11T09:00:00.000Z',
    updatedAt: '2026-08-11T09:00:00.000Z',
    project: { id: 'barandilla', name: 'Barandilla', color: '#2F6FEB' },
    ...overrides,
  };
}

/**
 * Which internal edge of a unit may say "the work carries on over there".
 *
 * The answer has to be "the one with a real hole on the clock", not "any edge that is not
 * the unit's own end". A unit joins rows with nothing WORKABLE between them, and two rows
 * that simply TOUCH satisfy that too — reachable whenever auto-merge may not fold them,
 * e.g. the scissors putting an hour in the top margin against the row below it. Read off
 * the position in the unit, the marks drew a seam down the middle of one unbroken
 * rectangle and the tooltip announced a lunch break that was not there.
 */
describe('segmentsOf — the seam is the hole, not the join', () => {
  const MANUAL_WINDOWS = [
    { startMinutes: 7 * 60, endMinutes: 14 * 60 },
    { startMinutes: 15 * 60 + 30, endMinutes: 20 * 60 + 30 },
  ];

  it('marks both ends of a unit really cut at the lunch break', () => {
    const segments = segmentsOf(
      groupBlocks(
        [
          block({ id: 'morning', startMinutes: 10 * 60, durationMinutes: 4 * 60 }),
          block({ id: 'afternoon', startMinutes: 15 * 60 + 30, durationMinutes: 2 * 60 }),
        ],
        MANUAL_WINDOWS,
      ),
      MANUAL_WINDOWS,
    );
    expect(segments).toHaveLength(2);
    expect([segments[0].seamAbove, segments[0].seamBelow]).toEqual([false, true]);
    expect([segments[1].seamAbove, segments[1].seamBelow]).toEqual([true, false]);
  });

  it('marks neither end when the two rows of the unit TOUCH', () => {
    const segments = segmentsOf(
      groupBlocks(
        [
          block({ id: 'margin', startMinutes: 7 * 60, durationMinutes: 60, locked: true }),
          block({ id: 'period', startMinutes: 8 * 60, durationMinutes: 3 * 60 }),
        ],
        MANUAL_WINDOWS,
      ),
      MANUAL_WINDOWS,
    );
    expect(segments).toHaveLength(2);
    // One unit — the grouping is right; it is only the seam that must not be drawn.
    expect(segments[0].group.id).toBe(segments[1].group.id);
    expect(segments.map((segment) => [segment.seamAbove, segment.seamBelow])).toEqual([
      [false, false],
      [false, false],
    ]);
    // The rounded corners are a different question and still follow the position.
    expect([segments[0].isFirst, segments[1].isLast]).toEqual([true, true]);
  });

  it('says nothing about a hole left by a margin the owner has since set to 0', () => {
    // 07:00-07:30 was dropped while the top margin existed; the margin is now 0, so the
    // half hour before 08:00 has stopped being workable and the two rows became one unit.
    // The hole is real, but it is not the comida and no mark may call it that.
    const narrowed = [
      { startMinutes: 8 * 60, endMinutes: 14 * 60 },
      { startMinutes: 15 * 60 + 30, endMinutes: 20 * 60 + 30 },
    ];
    const segments = segmentsOf(
      groupBlocks(
        [
          block({ id: 'margin', startMinutes: 7 * 60, durationMinutes: 30, locked: true }),
          block({ id: 'period', startMinutes: 8 * 60, durationMinutes: 2 * 60 }),
        ],
        narrowed,
      ),
      narrowed,
    );
    expect(segments[0].group.id).toBe(segments[1].group.id);
    expect(segments.map((segment) => [segment.seamAbove, segment.seamBelow])).toEqual([
      [false, false],
      [false, false],
    ]);
  });

  it('says nothing about a row that is a unit on its own', () => {
    const segments = segmentsOf(groupBlocks([block({ id: 'solo' })], MANUAL_WINDOWS), MANUAL_WINDOWS);
    expect([segments[0].seamAbove, segments[0].seamBelow]).toEqual([false, false]);
  });
});

/**
 * THE UNIT OF A DRAG, which is the run and not the unit on screen (owner, 2026-08-14):
 * «muevo todo hasta la tarea que los separe, indicativo de que esa división la he hecho yo».
 *
 * Read the way the engine reads it (`buildQueue`), so the drag and the reflow cannot
 * disagree about what one job's uninterrupted work is.
 */
describe('buildRuns', () => {
  const MANUAL = [
    { startMinutes: 7 * 60, endMinutes: 14 * 60 },
    { startMinutes: 15 * 60 + 30, endMinutes: 20 * 60 + 30 },
  ];

  /** Everything unlocked is movable here; the cases that need otherwise say so. */
  const movable = (candidate: WeekBlock): boolean => !candidate.locked;

  const runsOf = (blocks: readonly WeekBlock[]): Map<string, BlockRun> => {
    const byDate = new Map<string, WeekBlock[]>();
    for (const row of blocks) byDate.set(row.date, [...(byDate.get(row.date) ?? []), row]);
    return buildRuns(
      [...byDate.values()].flatMap((rows) => groupBlocks(rows, MANUAL)),
      movable,
    );
  };

  it('joins one job across days when nothing else is between the pieces', () => {
    // The owner's own example: this morning, this afternoon, and the day after tomorrow.
    const runs = runsOf([
      block({ id: 'wed-am', date: '2026-08-12', startMinutes: 12 * 60, durationMinutes: 120 }),
      block({ id: 'wed-pm', date: '2026-08-12', startMinutes: 15 * 60 + 30, durationMinutes: 120 }),
      block({ id: 'fri-am', date: '2026-08-14', startMinutes: 8 * 60, durationMinutes: 60 }),
    ]);
    expect(runs.get('wed-am')?.blockIds).toEqual(['wed-am', 'wed-pm', 'fri-am']);
    expect(runs.get('wed-am')?.totalMinutes).toBe(300);
    // Every unit of the run answers the same run, so grabbing any of them moves all of it.
    expect(runs.get('fri-am')).toBe(runs.get('wed-am'));
  });

  it('stops at another job, because that separation is the owner\'s own decision', () => {
    const runs = runsOf([
      block({ id: 'a1', startMinutes: 8 * 60, durationMinutes: 120 }),
      block({ id: 'other', projectId: 'reja', startMinutes: 10 * 60, durationMinutes: 60 }),
      block({ id: 'a2', startMinutes: 11 * 60, durationMinutes: 60 }),
    ]);
    expect(runs.get('a1')?.blockIds).toEqual(['a1']);
    expect(runs.get('a2')?.blockIds).toEqual(['a2']);
  });

  it('flows past work the engine never moves rather than stopping at it', () => {
    // A padlocked row is an obstacle the reflow flows around, exactly as `buildQueue` has
    // it — so it does not divide the job either, and it drags on its own.
    const runs = runsOf([
      block({ id: 'a1', startMinutes: 8 * 60, durationMinutes: 120 }),
      block({ id: 'pinned', projectId: 'reja', startMinutes: 10 * 60, durationMinutes: 60, locked: true }),
      block({ id: 'a2', startMinutes: 11 * 60, durationMinutes: 60 }),
    ]);
    expect(runs.get('a1')?.blockIds).toEqual(['a1', 'a2']);
    expect(runs.get('pinned')?.blockIds).toEqual(['pinned']);
  });

  it('joins three days of one job into ONE run, since nothing but another job divides one', () => {
    // A night does not break a run and neither does anything else: the hand-set length that
    // used to end one went with `manual_duration` (2026-08-18), so this is `buildQueue`'s
    // single item and the drag moves all three days.
    const runs = runsOf([
      block({ id: 'wed', date: '2026-08-12', startMinutes: 8 * 60, durationMinutes: 120 }),
      block({ id: 'thu', date: '2026-08-13', startMinutes: 8 * 60, durationMinutes: 60 }),
      block({ id: 'fri', date: '2026-08-14', startMinutes: 8 * 60, durationMinutes: 60 }),
    ]);
    expect(runs.get('wed')?.blockIds).toEqual(['wed', 'thu', 'fri']);
    expect(runs.get('thu')).toBe(runs.get('wed'));
    expect(runs.get('fri')).toBe(runs.get('wed'));
  });

  it('carries the unit on screen whole, padlocked rows in it included', () => {
    // A padlocked 07:00-08:00 against an unlocked 08:00-11:00 is ONE rectangle on screen
    // with one drag handle, so the run has to contain both or the gesture would split it.
    const runs = runsOf([
      block({ id: 'margin', startMinutes: 7 * 60, durationMinutes: 60, locked: true }),
      block({ id: 'period', startMinutes: 8 * 60, durationMinutes: 180 }),
    ]);
    expect(runs.get('margin')?.blockIds).toEqual(['margin', 'period']);
    expect(runs.get('margin')?.totalMinutes).toBe(240);
  });

  it('names the run\'s head, which is where the whole thing starts from', () => {
    const runs = runsOf([
      block({ id: 'thu', date: '2026-08-13', startMinutes: 12 * 60, durationMinutes: 120 }),
      block({ id: 'fri', date: '2026-08-14', startMinutes: 8 * 60, durationMinutes: 60 }),
    ]);
    expect(runs.get('fri')).toMatchObject({ date: '2026-08-13', startMinutes: 12 * 60 });
  });
});
