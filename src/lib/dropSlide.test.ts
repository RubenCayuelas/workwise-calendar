/**
 * Where a drop really lands when it cannot land where it was released.
 *
 * `firstClearStart` — the MINUTE — is exercised all over `composition.test.ts` and
 * `scheduler.test.ts`, through the drops that use it. What is proved here is `dropLanding`
 * — the DAY — on its own, because the rule it implements is about the calendar rather than
 * about any one drop: aiming past the end of a day means the day after, on the days the
 * engine lays out and nowhere else.
 *
 * Integer minutes throughout, and no clock: `dayOf` is an input, exactly as `today` is an
 * input to the engine. `reflows` is what a caller fills in from `dayReflows`.
 */

import { describe, expect, it } from 'vitest';
import { hhmmToMinutes as t } from './dates';
import { dropLanding, type DropDay } from './dropSlide';
import { manualWindowsOf } from './manualWindow';

const MON = '2026-08-10';
const THU = '2026-08-13';
const FRI = '2026-08-14';
const SAT = '2026-08-15';
const NEXT_MON = '2026-08-17';

/** The shop's split shift, with an hour of margin at either end. */
const PERIODS = [
  { startMinutes: t('08:00'), endMinutes: t('14:00') },
  { startMinutes: t('15:30'), endMinutes: t('19:30') },
];

/** A day the engine lays out: Monday to Friday, from today on, not closed. */
const OPEN: DropDay = {
  periods: PERIODS,
  manualWindows: manualWindowsOf(PERIODS, 60, 60),
  reflows: true,
};

/** The weekend, a closed day, the frozen past: the engine chooses nothing here. */
const FIXED: DropDay = { ...OPEN, reflows: false };

/** `fixedDates` stand for whatever made the engine let go of them. */
function calendar(fixedDates: string[] = []): (date: string) => DropDay {
  return (date) => (fixedDates.includes(date) ? FIXED : OPEN);
}

/** Saturday and Sunday, which the engine never lays out. */
const WEEKEND = ['2026-08-15', '2026-08-16'];

describe('dropLanding — a drop aimed below what the day holds', () => {
  it('leaves a drop that fits exactly where it was released', () => {
    // 6 h from 13:00 is 13:00-14:00 plus 15:30-20:30: the last minute of the day, margin
    // included, and the margin is a legitimate place to aim.
    expect(
      dropLanding({ date: THU, startMinutes: t('13:00'), durationMinutes: 360, dayOf: calendar(WEEKEND) }),
    ).toEqual({ date: THU, startMinutes: t('13:00') });
  });

  it('moves a drop a quarter of an hour too low to the next day, at the top of the periods', () => {
    // 6 h from 13:15 would end at 20:45, and the day ends at 20:30. The landing is 08:00,
    // not 07:00: a margin minute would padlock a run the owner never asked to fix.
    expect(
      dropLanding({ date: THU, startMinutes: t('13:15'), durationMinutes: 360, dayOf: calendar(WEEKEND) }),
    ).toEqual({ date: FRI, startMinutes: t('08:00') });
  });

  it('skips the weekend on the way out of a Friday', () => {
    expect(
      dropLanding({ date: FRI, startMinutes: t('19:00'), durationMinutes: 300, dayOf: calendar(WEEKEND) }),
    ).toEqual({ date: NEXT_MON, startMinutes: t('08:00') });
  });

  it('never rolls off a day the engine does not lay out', () => {
    // The weekend, a closed day and the past are days the owner named on purpose, and the
    // exact minute is the whole promise there. Moving the drop to another DATE would be a
    // bigger surprise than the end-of-day refusal it gets instead.
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
        dayOf: calendar([...WEEKEND, FRI]),
      }),
    ).toEqual({ date: NEXT_MON, startMinutes: t('08:00') });
  });

  it('reads every minute of the break as the first minute that can hold work', () => {
    // A release with no working time under it asks for a slot that does not exist. It is
    // settled here rather than only at the write, because the padlock, the queue rank and the
    // ghost's rectangle are all decided from this one start. 14:00 is the boundary that bit:
    // the exclusive END of the first window and before the start of the second, so it belonged
    // to no window and the drop was stored uncut, `14:00 +120m -> 16:00`.
    for (const minute of ['14:00', '14:01', '14:30', '15:00', '15:29', '15:30']) {
      expect(
        dropLanding({ date: THU, startMinutes: t(minute), durationMinutes: 120, dayOf: calendar(WEEKEND) }),
        `released at ${minute}`,
      ).toEqual({ date: THU, startMinutes: t('15:30') });
    }
    // The last minute of the morning is working time, so it is its own answer.
    expect(
      dropLanding({ date: THU, startMinutes: t('13:59'), durationMinutes: 120, dayOf: calendar(WEEKEND) }),
    ).toEqual({ date: THU, startMinutes: t('13:59') });
    // And it holds on a day the engine never lays out, where that minute is the whole promise.
    expect(
      dropLanding({ date: SAT, startMinutes: t('14:30'), durationMinutes: 120, dayOf: calendar(WEEKEND) }),
    ).toEqual({ date: SAT, startMinutes: t('15:30') });
  });

  it('rolls a run the afternoon cannot hold to the next day, measured from 15:30', () => {
    // 5 h aimed at the break is 5 h from 15:30, which reaches 20:30 — the day's last minute,
    // margin included — so it stays. Add a quarter of an hour and no part of the day can take
    // it, so it goes to Friday at the top of the periods.
    expect(
      dropLanding({ date: THU, startMinutes: t('14:00'), durationMinutes: 300, dayOf: calendar(WEEKEND) }),
    ).toEqual({ date: THU, startMinutes: t('15:30') });
    expect(
      dropLanding({ date: THU, startMinutes: t('14:00'), durationMinutes: 315, dayOf: calendar(WEEKEND) }),
    ).toEqual({ date: FRI, startMinutes: t('08:00') });
  });

  it('leaves the hole after the last window alone, afternoon switched off', () => {
    // The day is `07:00-15:00` and the hole after it runs to midnight: there is no later
    // working minute to offer, so the release stands and the roll answers for it instead.
    const morning: DropDay = {
      periods: [PERIODS[0]],
      manualWindows: manualWindowsOf([PERIODS[0]], 60, 60),
      reflows: true,
    };
    expect(
      dropLanding({ date: THU, startMinutes: t('15:00'), durationMinutes: 120, dayOf: () => morning }),
    ).toEqual({ date: FRI, startMinutes: t('08:00') });
    // And on a day the engine does not lay out there is nowhere to roll to: the release is
    // returned exactly as it was made and the write path's end-of-day guard refuses it.
    expect(
      dropLanding({
        date: SAT,
        startMinutes: t('18:00'),
        durationMinutes: 120,
        dayOf: () => ({ ...morning, reflows: false }),
      }),
    ).toEqual({ date: SAT, startMinutes: t('18:00') });
  });

  it('will not send a run to a day that could only hold it by using the margin', () => {
    // 10 h 30 fits from 08:00 only by running to 20:00, an hour into the bottom margin —
    // which would come back padlocked. No day can take it on those terms, so the drop is
    // left where it was released and the write path answers for it.
    expect(
      dropLanding({ date: MON, startMinutes: t('13:15'), durationMinutes: 630, dayOf: calendar(WEEKEND) }),
    ).toEqual({ date: MON, startMinutes: t('13:15') });
  });
});
