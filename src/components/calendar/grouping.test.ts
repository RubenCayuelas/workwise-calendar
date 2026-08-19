import { describe, expect, it } from 'vitest';
import {
  buildRuns,
  gapSegmentsOf,
  groupBlocks,
  groupGaps,
  segmentsOf,
  type BlockRun,
} from './grouping';
import type { WeekBlock } from '../../lib/api-client';
import type { Gap } from '../../types';

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

// Two rows of a unit may simply TOUCH — the scissors putting an hour in the top margin
// against the row below it — and a seam read off the position would mark that join too.
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
    // The top margin is now 0, so the half hour before 08:00 has stopped being workable
    // and the two rows became one unit. The hole is real, but it is not the comida.
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

// Read the way the engine reads it (`buildQueue`), so the drag and the reflow cannot
// disagree about what one job's uninterrupted work is.
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
    // An obstacle the reflow flows around does not divide the job, and drags on its own.
    const runs = runsOf([
      block({ id: 'a1', startMinutes: 8 * 60, durationMinutes: 120 }),
      block({ id: 'pinned', projectId: 'reja', startMinutes: 10 * 60, durationMinutes: 60, locked: true }),
      block({ id: 'a2', startMinutes: 11 * 60, durationMinutes: 60 }),
    ]);
    expect(runs.get('a1')?.blockIds).toEqual(['a1', 'a2']);
    expect(runs.get('pinned')?.blockIds).toEqual(['pinned']);
  });

  it('joins three days of one job into ONE run, since nothing but another job divides one', () => {
    // A night does not break a run and neither does anything else: one `buildQueue` item.
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
    // One rectangle on screen with one drag handle: the run has to contain both rows.
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

// ---------------------------------------------------------------------------
// The two halves of ONE gap
// ---------------------------------------------------------------------------

describe('groupGaps — a gap cut at the comida is one unit', () => {
  const MANUAL_WINDOWS = [
    { startMinutes: 7 * 60, endMinutes: 14 * 60 },
    { startMinutes: 15 * 60 + 30, endMinutes: 20 * 60 + 30 },
  ];

  function gap(overrides: Partial<Gap> & { id: string }): Gap {
    return {
      date: '2026-08-12',
      startMinutes: 10 * 60,
      durationMinutes: 60,
      reason: 'Feria',
      // Its own unit unless the case shares one on purpose: that is what makes two touching
      // absences stay two.
      unitId: overrides.id,
      createdAt: '2026-08-11T09:00:00.000Z',
      updatedAt: '2026-08-11T09:00:00.000Z',
      ...overrides,
    };
  }

  it('joins the two halves and marks both ends of the seam', () => {
    const groups = groupGaps(
      [
        gap({ id: 'morning', unitId: 'dia', startMinutes: 8 * 60, durationMinutes: 6 * 60 }),
        gap({ id: 'afternoon', unitId: 'dia', startMinutes: 15 * 60 + 30, durationMinutes: 5 * 60 }),
      ],
      MANUAL_WINDOWS,
    );

    expect(groups).toHaveLength(1);
    // The unit's own hours are NET — 11 h, not the 12.5 h its rectangle spans.
    expect(groups[0]).toMatchObject({ id: 'morning', totalMinutes: 11 * 60, reason: 'Feria' });
    expect(groups[0].endMinutes).toBe(20 * 60 + 30);

    const segments = gapSegmentsOf(groups, MANUAL_WINDOWS);
    expect(segments.map((segment) => [segment.seamAbove, segment.seamBelow])).toEqual([
      [false, true],
      [true, false],
    ]);
    expect(segments.map((segment) => [segment.isFirst, segment.isLast])).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  it('keeps two absences apart across the comida even when they say the SAME thing', () => {
    // The case reason-equality got wrong: a deleted job writes the same sentence on every past row,
    // so two independent absences would have fused into one unit. Their unit ids differ.
    const groups = groupGaps(
      [
        gap({ id: 'averia', unitId: 'averia', startMinutes: 12 * 60, durationMinutes: 2 * 60, reason: 'Feria' }),
        gap({ id: 'gestiones', unitId: 'gestiones', startMinutes: 15 * 60 + 30, durationMinutes: 60, reason: 'Feria' }),
      ],
      MANUAL_WINDOWS,
    );

    expect(groups.map((group) => group.id)).toEqual(['averia', 'gestiones']);
    expect(gapSegmentsOf(groups, MANUAL_WINDOWS).map((segment) => segment.seamBelow)).toEqual([
      false,
      false,
    ]);
  });

  it('leaves free time between two gaps as a separator', () => {
    const groups = groupGaps(
      [
        gap({ id: 'a', startMinutes: 9 * 60, durationMinutes: 60 }),
        gap({ id: 'b', startMinutes: 11 * 60, durationMinutes: 60 }),
      ],
      MANUAL_WINDOWS,
    );

    expect(groups).toHaveLength(2);
  });

  it('marks no seam where the two rows of a unit merely TOUCH', () => {
    // Same rule as a block's unit: the mark names the BREAK BETWEEN TWO WINDOWS, not the join
    // between two rows.
    const groups = groupGaps(
      [
        gap({ id: 'first', unitId: 'una', startMinutes: 9 * 60, durationMinutes: 60 }),
        gap({ id: 'second', unitId: 'una', startMinutes: 10 * 60, durationMinutes: 60 }),
      ],
      MANUAL_WINDOWS,
    );

    expect(groups).toHaveLength(1);
    expect(gapSegmentsOf(groups, MANUAL_WINDOWS).map((segment) => segment.seamBelow)).toEqual([
      false,
      false,
    ]);
  });
});
