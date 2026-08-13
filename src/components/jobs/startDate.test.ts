/**
 * What the create form says about a chosen start date.
 *
 * The placement itself is `src/lib/creation.test.ts`'s job. What is tested here is the
 * form's side of it: which notes apply, in which order, what colour the banner gets, and
 * that no list can grow long enough to bury the answer.
 */

import { describe, expect, it } from 'vitest';
import type { CreationPreview } from '../../lib/api-client';
import { summarizeStartDate } from './startDate';

const WED = '2026-08-12';
const THU = '2026-08-13';
const FRI = '2026-08-14';
const SAT = '2026-08-15';
const NEXT_MON = '2026-08-17';

/** A preview that lands exactly where it was asked to, with nothing in the way. */
function preview(overrides: Partial<CreationPreview> = {}): CreationPreview {
  return {
    today: WED,
    startDate: NEXT_MON,
    totalMinutes: 240,
    force: false,
    day: 'auto',
    mode: 'born',
    autoLock: false,
    handPlaced: false,
    needsDayConfirmation: false,
    deferred: false,
    canForce: false,
    startsOn: NEXT_MON,
    endsOn: NEXT_MON,
    rows: [{ date: NEXT_MON, startMinutes: 480, durationMinutes: 240, locked: false, handPlaced: false }],
    span: { startDate: NEXT_MON, endDate: NEXT_MON },
    collisions: [],
    freeDates: [NEXT_MON, THU],
    lastOccupiedDate: THU,
    ...overrides,
  };
}

function collision(date: string, name: string, minutes: number, locked = false) {
  return { projectId: `p-${name}`, projectName: name, date, minutes, locked, fixed: locked };
}

describe('summarizing a start-date preview', () => {
  it('says nothing is in the way, in an ordinary tone', () => {
    const summary = summarizeStartDate(preview());

    expect(summary.notes).toEqual(['clear']);
    expect(summary.tone).toBe('info');
    expect(summary.needsConfirmation).toBe(false);
    expect(summary.canForce).toBe(false);
  });

  it('leads with the day itself, then the deferral, then the lock', () => {
    const summary = summarizeStartDate(
      preview({ day: 'buffer', handPlaced: true, autoLock: true, deferred: true, startsOn: SAT }),
    );

    expect(summary.notes).toEqual(['buffer', 'deferred', 'autoLock', 'clear', 'freeDays']);
    expect(summary.tone).toBe('warning');
  });

  it('names the jobs in the way and adds up their hours', () => {
    const summary = summarizeStartDate(
      preview({
        collisions: [collision(WED, 'Puerta', 600), collision(THU, 'Puerta', 360)],
        span: { startDate: WED, endDate: THU },
      }),
    );

    expect(summary.collisionJobs).toBe(1);
    expect(summary.collisionMinutes).toBe(960);
    expect(summary.collisions.map((item) => item.key)).toEqual([
      `${WED}|p-Puerta`,
      `${THU}|p-Puerta`,
    ]);
    expect(summary.notes).not.toContain('clear');
    expect(summary.tone).toBe('warning');
  });

  it('warns that a locked block in the way is not moved', () => {
    const summary = summarizeStartDate(
      preview({ collisions: [collision(WED, 'Puerta', 120, true)] }),
    );

    expect(summary.notes).toContain('lockedStands');
  });

  it('offers free days only while the answer is unsatisfying', () => {
    expect(summarizeStartDate(preview()).notes).not.toContain('freeDays');
    expect(summarizeStartDate(preview({ deferred: true })).notes).toContain('freeDays');
    expect(
      summarizeStartDate(preview({ collisions: [collision(WED, 'Puerta', 60)] })).notes,
    ).toContain('freeDays');
    expect(summarizeStartDate(preview({ deferred: true, freeDates: [] })).notes).not.toContain(
      'freeDays',
    );
  });

  it('reports the forced note only when the plan really is forced', () => {
    expect(summarizeStartDate(preview({ force: true, mode: 'forced' })).notes).toContain('forced');
    // Force asked for but not applicable — the job is born on that day anyway.
    expect(summarizeStartDate(preview({ force: true, mode: 'born' })).notes).not.toContain('forced');
    expect(summarizeStartDate(preview({ force: true, mode: 'born' })).forced).toBe(false);
  });

  it('picks the confirmation from the day, not from the flag alone', () => {
    expect(summarizeStartDate(preview({ day: 'buffer', needsDayConfirmation: true })).confirmKind).toBe(
      'buffer',
    );
    expect(
      summarizeStartDate(preview({ day: 'weekend', needsDayConfirmation: true })).confirmKind,
    ).toBe('weekend');
    expect(summarizeStartDate(preview({ day: 'past' })).confirmKind).toBe(null);
  });

  it('abridges every list rather than burying the answer', () => {
    const rows = Array.from({ length: 9 }, (unused, index) => ({
      date: NEXT_MON,
      startMinutes: 480 + index * 30,
      durationMinutes: 30,
      locked: false,
      handPlaced: false,
    }));
    const collisions = Array.from({ length: 8 }, (unused, index) =>
      collision(NEXT_MON, `Job ${index}`, 60),
    );

    const summary = summarizeStartDate(preview({ rows, collisions }), {
      rows: 3,
      collisions: 2,
      freeDates: 1,
    });

    expect(summary.rows).toHaveLength(3);
    expect(summary.moreRows).toBe(6);
    expect(summary.collisions).toHaveLength(2);
    expect(summary.moreCollisions).toBe(6);
    expect(summary.freeDates).toHaveLength(1);
    // The totals still count everything, not just what is listed.
    expect(summary.collisionMinutes).toBe(480);
    expect(summary.collisionJobs).toBe(8);
  });

  it('admits when nothing could be placed at all', () => {
    const summary = summarizeStartDate(preview({ startsOn: null, endsOn: null, rows: [], span: null }));

    expect(summary.startsOn).toBe(null);
    expect(summary.notes).not.toContain('clear');
  });

  it('reads a past day as a warning, and does not repeat the padlock note', () => {
    const summary = summarizeStartDate(preview({ day: 'past', autoLock: true, startsOn: FRI }));

    // `past` already says the rows are created locked, and says why.
    expect(summary.notes).toEqual(['past', 'clear']);
    expect(summary.tone).toBe('warning');
  });
});
