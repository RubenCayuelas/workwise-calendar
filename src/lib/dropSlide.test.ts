// The MINUTE (`firstClearStart`) is exercised through the drops in composition.test.ts.

import { describe, expect, it } from 'vitest';
import { hhmmToMinutes as t } from './dates';
import { dropLanding, dropLandsLiterally, type DropDay } from './dropSlide';
import { manualWindowsOf } from './manualWindow';
import { FRI, MON, NEXT_MON, SAT, THU } from '../testing/fixtures';

const PERIODS = [
  { startMinutes: t('08:00'), endMinutes: t('14:00') },
  { startMinutes: t('15:30'), endMinutes: t('19:30') },
];

const WINDOWS = manualWindowsOf(PERIODS, 60, 60);

const OPEN: DropDay = {
  periods: PERIODS,
  manualWindows: WINDOWS,
  reflows: true,
  role: 'auto',
  closed: false,
};

/** The weekend, a closed day, the frozen past. */
const FIXED: DropDay = { ...OPEN, reflows: false, role: 'manual' };

/** The buffer: the engine lays it out, and yet a drop there keeps its minute. */
const BUFFER: DropDay = { ...OPEN, role: 'buffer' };

function calendar(fixedDates: string[] = []): (date: string) => DropDay {
  return (date) => {
    if (fixedDates.includes(date)) return FIXED;
    return date === FRI ? BUFFER : OPEN;
  };
}

const WEEKEND = ['2026-08-15', '2026-08-16'];

describe('dropLanding — a drop aimed below what the day holds', () => {
  it('leaves a drop that fits exactly where it was released', () => {
    // 6 h from 13:00 reaches 20:30: the day's last minute, margin included.
    expect(
      dropLanding({ date: THU, startMinutes: t('13:00'), durationMinutes: 360, dayOf: calendar(WEEKEND) }),
    ).toEqual({ date: THU, startMinutes: t('13:00') });
  });

  it('moves a padlocked drop a quarter of an hour too low to the next day, at the top of the periods', () => {
    // The landing is 08:00 and not 07:00: a margin minute would padlock a run nobody pinned.
    expect(
      dropLanding({
        date: THU,
        startMinutes: t('13:15'),
        durationMinutes: 360,
        fixed: true,
        dayOf: calendar(WEEKEND),
      }),
    ).toEqual({ date: FRI, startMinutes: t('08:00') });
  });

  it('skips the weekend on the way out of a Friday', () => {
    // The buffer keeps the minute a drop is released on, so its footprint has to fit it.
    expect(
      dropLanding({ date: FRI, startMinutes: t('19:00'), durationMinutes: 300, dayOf: calendar(WEEKEND) }),
    ).toEqual({ date: NEXT_MON, startMinutes: t('08:00') });
  });

  it('rolls a drop that starts in a visual margin, which is where it would be stored', () => {
    expect(
      dropLanding({ date: THU, startMinutes: t('19:45'), durationMinutes: 120, dayOf: calendar(WEEKEND) }),
    ).toEqual({ date: FRI, startMinutes: t('08:00') });
  });

  it('never rolls off a day the engine does not lay out', () => {
    // The exact minute is the whole promise there, so it is left for the write path.
    expect(
      dropLanding({ date: SAT, startMinutes: t('13:15'), durationMinutes: 360, dayOf: calendar(WEEKEND) }),
    ).toEqual({ date: SAT, startMinutes: t('13:15') });
  });

  it('steps over a closed day', () => {
    expect(
      dropLanding({
        date: THU,
        startMinutes: t('13:15'),
        durationMinutes: 360,
        fixed: true,
        dayOf: calendar([...WEEKEND, FRI]),
      }),
    ).toEqual({ date: NEXT_MON, startMinutes: t('08:00') });
  });

  it('reads every minute of the break as the first minute that can hold work', () => {
    // The padlock, the rank and the ghost all read this start; 14:00 is the boundary that bit.
    for (const minute of ['14:00', '14:01', '14:30', '15:00', '15:29', '15:30']) {
      expect(
        dropLanding({ date: THU, startMinutes: t(minute), durationMinutes: 120, dayOf: calendar(WEEKEND) }),
        `released at ${minute}`,
      ).toEqual({ date: THU, startMinutes: t('15:30') });
    }
    expect(
      dropLanding({ date: THU, startMinutes: t('13:59'), durationMinutes: 120, dayOf: calendar(WEEKEND) }),
    ).toEqual({ date: THU, startMinutes: t('13:59') });
    expect(
      dropLanding({ date: SAT, startMinutes: t('14:30'), durationMinutes: 120, dayOf: calendar(WEEKEND) }),
    ).toEqual({ date: SAT, startMinutes: t('15:30') });
  });

  it('rolls a padlocked run the afternoon cannot hold to the next day, measured from 15:30', () => {
    // 5 h from 15:30 reaches 20:30 and stays; a quarter more fits nowhere and goes to Friday.
    expect(
      dropLanding({
        date: THU,
        startMinutes: t('14:00'),
        durationMinutes: 300,
        fixed: true,
        dayOf: calendar(WEEKEND),
      }),
    ).toEqual({ date: THU, startMinutes: t('15:30') });
    expect(
      dropLanding({
        date: THU,
        startMinutes: t('14:00'),
        durationMinutes: 315,
        fixed: true,
        dayOf: calendar(WEEKEND),
      }),
    ).toEqual({ date: FRI, startMinutes: t('08:00') });
  });

  it('leaves the hole after the last window alone, afternoon switched off', () => {
    const morning: DropDay = {
      periods: [PERIODS[0]],
      manualWindows: manualWindowsOf([PERIODS[0]], 60, 60),
      reflows: true,
      role: 'auto',
      closed: false,
    };
    expect(
      dropLanding({ date: THU, startMinutes: t('15:00'), durationMinutes: 120, dayOf: () => morning }),
    ).toEqual({ date: FRI, startMinutes: t('08:00') });
    // Nowhere to roll to on a fixed day: the end-of-day guard refuses the release instead.
    expect(
      dropLanding({
        date: SAT,
        startMinutes: t('18:00'),
        durationMinutes: 120,
        dayOf: () => ({ ...morning, reflows: false, role: 'manual' }),
      }),
    ).toEqual({ date: SAT, startMinutes: t('18:00') });
  });

  it('will not send a padlocked run to a day that could only hold it by using the margin', () => {
    // 10 h 30 fits only by using the margin, which would padlock it: no day can take it.
    expect(
      dropLanding({
        date: MON,
        startMinutes: t('13:15'),
        durationMinutes: 630,
        fixed: true,
        dayOf: calendar(WEEKEND),
      }),
    ).toEqual({ date: MON, startMinutes: t('13:15') });
  });
});

describe('dropLanding — a queue rank has no footprint to fit', () => {
  // Pins the silent no-op: 6 h into a 4 h afternoon is 4 h here and 2 h tomorrow, not a roll.
  it('leaves an unlocked Monday-Thursday release exactly where it was made', () => {
    expect(
      dropLanding({ date: MON, startMinutes: t('15:30'), durationMinutes: 360, dayOf: calendar(WEEKEND) }),
    ).toEqual({ date: MON, startMinutes: t('15:30') });
    expect(
      dropLanding({ date: THU, startMinutes: t('13:15'), durationMinutes: 360, dayOf: calendar(WEEKEND) }),
    ).toEqual({ date: THU, startMinutes: t('13:15') });
  });

  it('holds however long the run is — a run no day could ever hold is still a rank', () => {
    expect(
      dropLanding({ date: MON, startMinutes: t('11:00'), durationMinutes: 3000, dayOf: calendar(WEEKEND) }),
    ).toEqual({ date: MON, startMinutes: t('11:00') });
  });

  it('still reads a release in the lunch band as the next working minute', () => {
    expect(
      dropLanding({ date: MON, startMinutes: t('14:45'), durationMinutes: 600, dayOf: calendar(WEEKEND) }),
    ).toEqual({ date: MON, startMinutes: t('15:30') });
  });
});

describe('dropLandsLiterally — the one place the padlock policy lives', () => {
  const ask = (input: {
    fixed?: boolean;
    role?: DropDay['role'];
    closed?: boolean;
    startMinutes: number;
    durationMinutes: number;
  }): boolean =>
    dropLandsLiterally({
      fixed: input.fixed ?? false,
      role: input.role ?? 'auto',
      closed: input.closed ?? false,
      periods: PERIODS,
      manualWindows: WINDOWS,
      startMinutes: input.startMinutes,
      durationMinutes: input.durationMinutes,
    });

  it('pins by the DAY: the buffer, the weekend, and a row already padlocked', () => {
    expect(ask({ role: 'buffer', startMinutes: t('09:00'), durationMinutes: 120 })).toBe(true);
    expect(ask({ role: 'manual', startMinutes: t('09:00'), durationMinutes: 120 })).toBe(true);
    expect(ask({ fixed: true, startMinutes: t('09:00'), durationMinutes: 120 })).toBe(true);
    expect(ask({ startMinutes: t('09:00'), durationMinutes: 120 })).toBe(false);
  });

  it('pins by the SLOT: a start inside a visual margin, top or bottom', () => {
    expect(ask({ startMinutes: t('07:00'), durationMinutes: 120 })).toBe(true);
    expect(ask({ startMinutes: t('19:45'), durationMinutes: 60 })).toBe(true);
    // A quarter of an hour is where a request begins: one minute off 08:00 is a tie-break.
    expect(ask({ startMinutes: t('07:59'), durationMinutes: 120 })).toBe(false);
    expect(ask({ startMinutes: t('07:45'), durationMinutes: 120 })).toBe(true);
  });

  it('does NOT pin a footprint that merely runs past the end of the periods', () => {
    expect(ask({ startMinutes: t('15:30'), durationMinutes: 360 })).toBe(false);
    expect(ask({ startMinutes: t('19:00'), durationMinutes: 120 })).toBe(false);
    expect(ask({ role: 'buffer', startMinutes: t('15:30'), durationMinutes: 360 })).toBe(true);
  });

  it('does not pin a drop aimed at the lunch break: it is read as 15:30', () => {
    for (const minute of ['14:00', '15:00', '15:29']) {
      expect(ask({ startMinutes: t(minute), durationMinutes: 120 }), minute).toBe(false);
    }
  });
});
