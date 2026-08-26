/**
 * The day picker's keyboard movement. The suite runs in `node` with no DOM, so the move is decided
 * from a key NAME rather than from a `KeyboardEvent`, and this is what pins it.
 *
 * The property that matters most is the last one: no key ever answers with a day the window does
 * not offer, because such a cell cannot be clicked either and focus on one is a dead end.
 */

import { describe, expect, it } from 'vitest';
import { addDays, compareDates } from '../../lib/dates';
import { LAST_WED, MON, NEXT_WED, SUN, THU, TUE, WED } from '../../testing/fixtures';
import { planningWindow, type DayWindow } from './dateOptions';
import { isDayPickerKey, moveFocusedDay, type DayPickerKey } from './dayPickerKeys';

/** The window the wireframe's Wednesday really opens with: 2026-07-13 … 2026-10-04. */
const WINDOW = planningWindow(WED, 8);

/** Wide enough that a page turn is never clamped, so the month arithmetic reads on its own. */
const YEAR: DayWindow = { minDate: '2026-01-01', maxDate: '2026-12-31' };

const BACKWARD: DayPickerKey[] = ['ArrowLeft', 'ArrowUp', 'PageUp', 'Home'];
const FORWARD: DayPickerKey[] = ['ArrowRight', 'ArrowDown', 'PageDown', 'End'];
const EVERY_KEY: DayPickerKey[] = [...BACKWARD, ...FORWARD];

describe('isDayPickerKey', () => {
  it('recognises the eight keys the grid answers, and no more', () => {
    expect(EVERY_KEY).toHaveLength(8);
    for (const key of EVERY_KEY) expect(isDayPickerKey(key)).toBe(true);
  });

  it('leaves every other key to whatever else wants it', () => {
    for (const key of ['Enter', 'Escape', 'Tab', ' ', 'a', 'ArrowLeftRight', 'constructor']) {
      expect(isDayPickerKey(key)).toBe(false);
    }
  });
});

describe('moveFocusedDay', () => {
  it('steps a day with the left and the right arrow', () => {
    expect(moveFocusedDay(WED, 'ArrowLeft', WINDOW)).toBe(TUE);
    expect(moveFocusedDay(WED, 'ArrowRight', WINDOW)).toBe(THU);
  });

  it('steps a week with the up and the down arrow', () => {
    expect(moveFocusedDay(WED, 'ArrowUp', WINDOW)).toBe(LAST_WED);
    expect(moveFocusedDay(WED, 'ArrowDown', WINDOW)).toBe(NEXT_WED);
  });

  it('lands on the Monday and the Sunday of that week', () => {
    expect(moveFocusedDay(WED, 'Home', WINDOW)).toBe(MON);
    expect(moveFocusedDay(WED, 'End', WINDOW)).toBe(SUN);
    expect(moveFocusedDay(MON, 'Home', WINDOW)).toBe(MON);
    expect(moveFocusedDay(SUN, 'End', WINDOW)).toBe(SUN);
  });

  it('keeps the day of the month across a page turn', () => {
    expect(moveFocusedDay(WED, 'PageUp', YEAR)).toBe('2026-07-12');
    expect(moveFocusedDay(WED, 'PageDown', YEAR)).toBe('2026-09-12');
  });

  it('falls back to the last day a shorter month has', () => {
    // 31 January and 31 March both page onto 28 February, which is all 2026 has.
    expect(moveFocusedDay('2026-01-31', 'PageDown', YEAR)).toBe('2026-02-28');
    expect(moveFocusedDay('2026-03-31', 'PageUp', YEAR)).toBe('2026-02-28');
  });

  it('stops on the first day the window offers', () => {
    for (const key of BACKWARD) {
      expect(moveFocusedDay(WINDOW.minDate, key, WINDOW)).toBe(WINDOW.minDate);
    }
  });

  it('stops on the last day the window offers', () => {
    for (const key of FORWARD) {
      expect(moveFocusedDay(WINDOW.maxDate, key, WINDOW)).toBe(WINDOW.maxDate);
    }
  });

  it('clamps a page turn that would land on a drawn but unreachable day', () => {
    // The window opens on Monday 13 July, so the grid draws 12 July without offering it.
    expect(WINDOW.minDate).toBe('2026-07-13');
    expect(moveFocusedDay(WED, 'PageUp', WINDOW)).toBe('2026-07-13');
  });

  it('steps a stored day from outside the window onto the nearest day inside it', () => {
    for (const key of EVERY_KEY) {
      expect(moveFocusedDay('2026-01-09', key, WINDOW)).toBe(WINDOW.minDate);
      expect(moveFocusedDay('2027-03-01', key, WINDOW)).toBe(WINDOW.maxDate);
    }
  });

  it('never answers with a day outside the window', () => {
    for (
      let date = WINDOW.minDate;
      compareDates(date, WINDOW.maxDate) <= 0;
      date = addDays(date, 1)
    ) {
      for (const key of EVERY_KEY) {
        const landed = moveFocusedDay(date, key, WINDOW);
        expect(compareDates(landed, WINDOW.minDate)).toBeGreaterThanOrEqual(0);
        expect(compareDates(landed, WINDOW.maxDate)).toBeLessThanOrEqual(0);
      }
    }
  });
});
