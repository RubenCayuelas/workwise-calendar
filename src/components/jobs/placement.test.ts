/**
 * The placement diff is the one piece of logic in this folder, so it is the one piece
 * with tests. Everything else is a controlled form over `src/lib/api-client.ts`.
 *
 * The dates are the wireframe's own week: 2026-08-10 is the Monday of ISO week 33,
 * 2026-08-14 the Friday buffer, 2026-08-17 next week's Monday.
 */

import { describe, expect, it } from 'vitest';
import {
  describePlacement,
  otherGapConflicts,
  placementHighlights,
  readGapConflicts,
  sumMinutes,
} from './placement';
import type { Block } from '../../types';
import { FRI, MON, NEXT_MON, TUE } from '../../testing/fixtures';

function block(overrides: Partial<Block> & { id: string }): Block {
  return {
    projectId: 'job-1',
    date: MON,
    startMinutes: 8 * 60,
    durationMinutes: 120,
    locked: false,
    createdAt: '2026-08-01 09:00:00',
    updatedAt: '2026-08-01 09:00:00',
    ...overrides,
  };
}

describe('sumMinutes', () => {
  it('adds the rows up in exact integer minutes', () => {
    expect(sumMinutes([block({ id: 'a', durationMinutes: 150 }), block({ id: 'b', durationMinutes: 90 })])).toBe(
      240,
    );
  });
});

describe('describePlacement', () => {
  it('reports a created job as new rows, with its total', () => {
    const after = [
      block({ id: 'a', date: MON, durationMinutes: 360 }),
      block({ id: 'b', date: TUE, durationMinutes: 120 }),
    ];

    const outcome = describePlacement([], after, MON);

    expect(outcome.minutesDelta).toBe(480);
    expect(outcome.changes.map((change) => change.kind)).toEqual(['new', 'new']);
    expect(outcome.furthestDate).toBe(TUE);
    expect(outcome.hasChanges).toBe(true);
  });

  it('tells grown, shrunk and moved rows apart', () => {
    const before = [
      block({ id: 'a', durationMinutes: 120 }),
      block({ id: 'b', durationMinutes: 120 }),
      block({ id: 'c', durationMinutes: 120 }),
    ];
    const after = [
      block({ id: 'a', durationMinutes: 180 }),
      block({ id: 'b', durationMinutes: 60 }),
      block({ id: 'c', date: TUE }),
    ];

    const kinds = new Map(
      describePlacement(before, after, MON).changes.map((change) => [change.block.id, change.kind]),
    );

    expect(kinds.get('a')).toBe('grown');
    expect(kinds.get('b')).toBe('shrunk');
    expect(kinds.get('c')).toBe('moved');
  });

  it('says nothing changed when only the job metadata was edited', () => {
    const rows = [block({ id: 'a' }), block({ id: 'b', date: TUE })];

    const outcome = describePlacement(rows, rows.map((row) => ({ ...row })), MON);

    expect(outcome.changes).toEqual([]);
    expect(outcome.removedBlockIds).toEqual([]);
    expect(outcome.hasChanges).toBe(false);
    expect(outcome.minutesDelta).toBe(0);
  });

  it('flags the Friday buffer when the extra hours land there', () => {
    const before = [block({ id: 'a' })];
    const after = [block({ id: 'a' }), block({ id: 'b', date: FRI, durationMinutes: 120 })];

    const outcome = describePlacement(before, after, MON);

    expect(outcome.usedBuffer).toBe(true);
    expect(outcome.spilledToLaterWeek).toBe(false);
    expect(outcome.changes.find((change) => change.block.id === 'b')?.isBuffer).toBe(true);
  });

  it('does not call the buffer used when a Friday row only got shorter', () => {
    const before = [block({ id: 'a', date: FRI, durationMinutes: 240 })];
    const after = [block({ id: 'a', date: FRI, durationMinutes: 120 })];

    const outcome = describePlacement(before, after, MON);

    expect(outcome.usedBuffer).toBe(false);
    expect(outcome.minutesDelta).toBe(-120);
  });

  it('flags a later week, which is the placement the week on screen cannot show', () => {
    const before = [block({ id: 'a' })];
    const after = [block({ id: 'a' }), block({ id: 'b', date: NEXT_MON, durationMinutes: 360 })];

    const outcome = describePlacement(before, after, MON);

    expect(outcome.spilledToLaterWeek).toBe(true);
    expect(outcome.changes.find((change) => change.block.id === 'b')?.isLaterWeek).toBe(true);
    // Row 'a' is untouched, so it is not reported at all.
    expect(outcome.changes.map((change) => change.block.id)).toEqual(['b']);
  });

  it('reports rows that no longer exist — LIFO removal and auto-merge both do this', () => {
    const before = [block({ id: 'a' }), block({ id: 'b', date: TUE })];
    const after = [block({ id: 'a', durationMinutes: 240 })];

    const outcome = describePlacement(before, after, MON);

    expect(outcome.removedBlockIds).toEqual(['b']);
    expect(outcome.hasChanges).toBe(true);
  });

  it('orders the changes the way the calendar reads', () => {
    const after = [
      block({ id: 'late', date: TUE, startMinutes: 15 * 60 + 30 }),
      block({ id: 'early', date: MON, startMinutes: 8 * 60 }),
      block({ id: 'mid', date: TUE, startMinutes: 8 * 60 }),
    ];

    expect(describePlacement([], after, MON).changes.map((change) => change.block.id)).toEqual([
      'early',
      'mid',
      'late',
    ]);
  });
});

describe('placementHighlights', () => {
  it('prefers the rows the hours arrived in over the rows that merely moved', () => {
    const before = [block({ id: 'a' }), block({ id: 'b', date: TUE })];
    const after = [
      block({ id: 'a', date: TUE, startMinutes: 12 * 60 }),
      block({ id: 'b', date: TUE, durationMinutes: 240 }),
    ];

    const highlights = placementHighlights(describePlacement(before, after, MON));

    expect(highlights.map((change) => change.block.id)).toEqual(['b']);
  });

  it('falls back to the moved rows when nothing was added', () => {
    const before = [block({ id: 'a' })];
    const after = [block({ id: 'a', date: TUE })];

    expect(placementHighlights(describePlacement(before, after, MON))).toHaveLength(1);
  });

  it('caps the list so a long job cannot flood the panel', () => {
    const after = Array.from({ length: 10 }, (_unused, index) =>
      block({ id: `b${index}`, date: MON, startMinutes: 8 * 60 + index }),
    );

    expect(placementHighlights(describePlacement([], after, MON))).toHaveLength(6);
  });
});

describe('readGapConflicts', () => {
  const conflict = {
    blockId: 'block-1',
    projectId: 'job-1',
    projectName: 'Railing',
    date: TUE,
    startMinutes: 480,
    durationMinutes: 240,
    reason: 'locked',
  };

  it('reads what the API sent', () => {
    expect(readGapConflicts({ conflicts: [conflict] })).toEqual([conflict]);
  });

  it('drops anything malformed rather than trusting the wire', () => {
    expect(
      readGapConflicts({
        conflicts: [null, 'nope', { ...conflict, reason: 'because' }, { ...conflict, startMinutes: '480' }],
      }),
    ).toEqual([]);
  });

  it('survives a missing or wrongly typed details payload', () => {
    expect(readGapConflicts(undefined)).toEqual([]);
    expect(readGapConflicts({ conflicts: 'one' })).toEqual([]);
  });

  it('leaves the project name empty rather than inventing one', () => {
    const { projectName, ...withoutName } = conflict;
    expect(projectName).toBe('Railing');
    expect(readGapConflicts({ conflicts: [withoutName] })[0].projectName).toBe('');
  });
});

describe('otherGapConflicts', () => {
  const locked = {
    blockId: 'block-locked',
    projectId: 'job-1',
    projectName: 'Railing',
    date: TUE,
    startMinutes: 480,
    durationMinutes: 240,
    reason: 'locked',
  };
  const past = {
    blockId: 'block-past',
    projectId: 'job-2',
    projectName: 'Door',
    date: TUE,
    startMinutes: 930,
    durationMinutes: 120,
    reason: 'past',
  };

  it('drops the one the message already names, wherever it sits in the array', () => {
    // `assertGapFits` reports the LOCKED conflict in the message even though the past
    // one comes first in the array, so position is not what identifies it.
    const details = {
      projectName: 'Railing',
      date: TUE,
      startTime: '08:00',
      endTime: '12:00',
      reason: 'locked',
      conflicts: [past, locked],
    };

    expect(otherGapConflicts(details).map((item) => item.blockId)).toEqual(['block-past']);
  });

  it('keeps every conflict when the headline cannot be identified', () => {
    expect(otherGapConflicts({ conflicts: [past, locked] })).toHaveLength(2);
  });
});
