import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../lib/settings';
import type { Block, Settings } from '../../types';
import {
  assessRisk,
  findAffectedBlocks,
  needsBlockCheck,
  subtractIntervals,
  type ScheduledBlock,
} from './warnings';

function settings(patch: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

/** A block on the calendar, in the engine's integer minutes. */
function scheduled(
  id: string,
  date: string,
  startMinutes: number,
  durationMinutes: number,
  projectName = 'Escalera',
): ScheduledBlock {
  const block: Block = {
    id,
    projectId: `project-${id}`,
    date,
    startMinutes,
    durationMinutes,
    locked: false,
    createdAt: '2026-08-10 09:00:00',
    updatedAt: '2026-08-10 09:00:00',
  };
  return { block, projectName };
}

describe('subtractIntervals', () => {
  it('reports nothing removed when the day is unchanged', () => {
    const periods = [{ startMinutes: 480, endMinutes: 840 }];
    expect(subtractIntervals(periods, periods)).toEqual([]);
  });

  it('reports the tail lost when a period ends earlier', () => {
    expect(
      subtractIntervals(
        [{ startMinutes: 480, endMinutes: 840 }],
        [{ startMinutes: 480, endMinutes: 780 }],
      ),
    ).toEqual([{ startMinutes: 780, endMinutes: 840 }]);
  });

  it('reports both ends when a period is squeezed from both sides', () => {
    expect(
      subtractIntervals(
        [{ startMinutes: 480, endMinutes: 840 }],
        [{ startMinutes: 540, endMinutes: 780 }],
      ),
    ).toEqual([
      { startMinutes: 480, endMinutes: 540 },
      { startMinutes: 780, endMinutes: 840 },
    ]);
  });

  it('reports a whole period lost when it disappears', () => {
    expect(
      subtractIntervals(
        [
          { startMinutes: 480, endMinutes: 840 },
          { startMinutes: 930, endMinutes: 1170 },
        ],
        [{ startMinutes: 480, endMinutes: 840 }],
      ),
    ).toEqual([{ startMinutes: 930, endMinutes: 1170 }]);
  });
});

describe('assessRisk', () => {
  it('sees nothing narrowing in a colour change', () => {
    const risk = assessRisk(settings(), settings({ gapColor: '#AABBCC' }));
    expect(risk).toEqual({
      disablesAfternoon: false,
      narrowsPeriods: false,
      narrowsTimeline: false,
      narrowsHorizon: false,
      lowersCapacity: false,
    });
    expect(needsBlockCheck(risk)).toBe(false);
  });

  it('sees the afternoon being switched off', () => {
    const risk = assessRisk(settings(), settings({ period2Enabled: false }));
    expect(risk.disablesAfternoon).toBe(true);
    expect(risk.narrowsPeriods).toBe(true);
    expect(needsBlockCheck(risk)).toBe(true);
  });

  it('sees a shrunk visual margin, which would clip work off the axis', () => {
    const risk = assessRisk(settings(), settings({ visualMarginBottom: 0 }));
    expect(risk.narrowsPeriods).toBe(false);
    expect(risk.narrowsTimeline).toBe(true);
    expect(needsBlockCheck(risk)).toBe(true);
  });

  it('does not ask for a block check when the day only gets longer', () => {
    const risk = assessRisk(settings(), settings({ period2End: '20:30' }));
    expect(needsBlockCheck(risk)).toBe(false);
  });

  it('flags a narrower horizon and a lower capacity without a block check', () => {
    const risk = assessRisk(
      settings(),
      settings({ planningHorizonWeeks: 4, defaultDayCapacity: 8 }),
    );
    expect(risk.narrowsHorizon).toBe(true);
    expect(risk.lowersCapacity).toBe(true);
    // Neither strands a block: the reflow simply places work later.
    expect(needsBlockCheck(risk)).toBe(false);
  });
});

describe('findAffectedBlocks', () => {
  const afternoonWork = scheduled('a', '2026-08-12', 930, 120, 'Portón'); // 15:30-17:30
  const morningWork = scheduled('b', '2026-08-12', 480, 360, 'Puerta'); // 08:00-14:00

  it('names the afternoon blocks when the afternoon is switched off', () => {
    const affected = findAffectedBlocks(
      settings(),
      settings({ period2Enabled: false }),
      [morningWork, afternoonWork],
    );
    expect(affected.map((entry) => entry.block.id)).toEqual(['a']);
    expect(affected[0].reason).toBe('outside-periods');
    expect(affected[0].projectName).toBe('Portón');
  });

  it('leaves the morning alone when only the afternoon goes', () => {
    const affected = findAffectedBlocks(settings(), settings({ period2Enabled: false }), [morningWork]);
    expect(affected).toEqual([]);
  });

  it('names a block that would only partly lose its time', () => {
    // The morning ends at 13:00: the last hour of an 08:00-14:00 block is gone.
    const affected = findAffectedBlocks(settings(), settings({ period1End: '13:00' }), [morningWork]);
    expect(affected.map((entry) => entry.block.id)).toEqual(['b']);
  });

  it('names a block that a shrunk margin would clip off the axis', () => {
    // 07:00-08:00 is the top margin: legal by hand, invisible once the margin is 0.
    const inMargin = scheduled('c', '2026-08-12', 420, 60);
    const affected = findAffectedBlocks(settings(), settings({ visualMarginTop: 0 }), [inMargin]);
    expect(affected.map((entry) => entry.reason)).toEqual(['outside-timeline']);
  });

  it('does not complain about work that stays inside the new day', () => {
    const affected = findAffectedBlocks(settings(), settings({ period2End: '18:00' }), [afternoonWork]);
    expect(affected).toEqual([]);
  });

  it('includes the past and the weekend, which the engine will never fix', () => {
    const saturday = scheduled('d', '2026-08-15', 930, 60, 'Barandilla');
    const past = scheduled('e', '2026-08-03', 1050, 60, 'Puerta');
    const affected = findAffectedBlocks(
      settings(),
      settings({ period2Enabled: false }),
      [saturday, past],
    );
    // Sorted in calendar order, so the list reads like the calendar.
    expect(affected.map((entry) => entry.block.id)).toEqual(['e', 'd']);
  });

  it('stays quiet while a period time is unusable, since that draft cannot be saved', () => {
    const affected = findAffectedBlocks(
      settings(),
      settings({ period1Start: '', period2Enabled: false }),
      [morningWork, afternoonWork],
    );
    expect(affected).toEqual([]);
  });
});
