/**
 * The visual unit, and in particular what it carries about a HAND-SET length.
 *
 * A unit is one gesture on screen but several rows in the database, so the two facts
 * the block draws — the padlock and the hand-set mark — roll up differently and this
 * is where that is pinned down. `locked` answers a yes/no question about the whole
 * unit; `manualBlockIds` has to name the rows, because that list is exactly what
 * *back to automatic* sends and a unit can legitimately be half hand-set.
 */

import { describe, expect, it } from 'vitest';
import { groupBlocks, segmentsOf } from './grouping';
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
    manualDuration: false,
    handPlaced: false,
    createdAt: '2026-08-11T09:00:00.000Z',
    updatedAt: '2026-08-11T09:00:00.000Z',
    project: { id: 'barandilla', name: 'Barandilla', color: '#2F6FEB' },
    ...overrides,
  };
}

describe('groupBlocks — the hand-set mark', () => {
  it('leaves the list empty when the engine owns every row', () => {
    const groups = groupBlocks([block({ id: 'a' })], PERIODS);
    expect(groups[0].manualBlockIds).toEqual([]);
  });

  it('keeps both halves of a stretch that had to be cut at the lunch break', () => {
    // The engine stores a 7 h hand-set stretch as 13:00-14:00 plus 15:30-19:30 and
    // reads them back as ONE stretch; the unit has to be able to release both.
    const groups = groupBlocks(
      [
        block({ id: 'morning', startMinutes: 13 * 60, durationMinutes: 60, manualDuration: true }),
        block({
          id: 'afternoon',
          startMinutes: 15 * 60 + 30,
          durationMinutes: 4 * 60,
          manualDuration: true,
        }),
      ],
      PERIODS,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].manualBlockIds).toEqual(['morning', 'afternoon']);
    expect(groups[0].manualBlockIds.length).toBe(groups[0].blocks.length);
  });

  it('names only the hand-set half of a unit the owner half sized', () => {
    const groups = groupBlocks(
      [
        block({ id: 'drawn', startMinutes: 13 * 60, durationMinutes: 60, manualDuration: true }),
        block({ id: 'auto', startMinutes: 15 * 60 + 30, durationMinutes: 60 }),
      ],
      PERIODS,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].manualBlockIds).toEqual(['drawn']);
    // The unit is still one thing to drag, and only part of it is hand-set — which is
    // why the group cannot answer this with a single boolean.
    expect(groups[0].manualBlockIds.length).toBeLessThan(groups[0].blocks.length);
  });

  it('does not leak the mark across two jobs that merely touch', () => {
    const groups = groupBlocks(
      [
        block({ id: 'a', durationMinutes: 60, manualDuration: true }),
        block({ id: 'b', projectId: 'porton', startMinutes: 9 * 60, durationMinutes: 60 }),
      ],
      PERIODS,
    );
    expect(groups.map((group) => group.manualBlockIds)).toEqual([['a'], []]);
  });
});

describe('groupBlocks — what *back to automatic* releases', () => {
  it('is empty while the engine owns the unit', () => {
    expect(groupBlocks([block({ id: 'a' })], PERIODS)[0].releasableBlockIds).toEqual([]);
  });

  it('covers a hand-PLACED row whose length is perfectly automatic', () => {
    // The Friday defect's row: pinned to a day, sized by the engine. Keying the action
    // off `manualBlockIds` alone would leave it with no visible way back.
    const groups = groupBlocks([block({ id: 'viernes', handPlaced: true })], PERIODS);
    expect(groups[0].manualBlockIds).toEqual([]);
    expect(groups[0].releasableBlockIds).toEqual(['viernes']);
  });

  it('names each row once when a row carries both marks', () => {
    const groups = groupBlocks(
      [block({ id: 'ambas', manualDuration: true, handPlaced: true })],
      PERIODS,
    );
    expect(groups[0].releasableBlockIds).toEqual(['ambas']);
  });

  it('gathers both halves of a unit the owner pinned and then sized', () => {
    const groups = groupBlocks(
      [
        block({ id: 'morning', startMinutes: 13 * 60, durationMinutes: 60, handPlaced: true }),
        block({
          id: 'afternoon',
          startMinutes: 15 * 60 + 30,
          durationMinutes: 60,
          manualDuration: true,
        }),
      ],
      PERIODS,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].releasableBlockIds).toEqual(['morning', 'afternoon']);
  });
});

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
          block({ id: 'margin', startMinutes: 7 * 60, durationMinutes: 60, handPlaced: true }),
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
          block({ id: 'margin', startMinutes: 7 * 60, durationMinutes: 30, handPlaced: true }),
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
