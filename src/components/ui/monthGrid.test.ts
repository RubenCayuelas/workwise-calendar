/**
 * The month grid the day picker draws.
 *
 * Six rows always, whatever the month: the popover is then a constant height, so clipping it
 * against the window is arithmetic and not a measurement. And `selectable` is the whole of how
 * far the picker reaches — the day already stored is offered however far outside the window it
 * falls, while a day the window does not reach is drawn and cannot be chosen.
 */

import { describe, expect, it } from 'vitest';
import { MONDAY, addDays, weekdayOf } from '../../lib/dates';
import { planningWindow, type DayWindow } from './dateOptions';
import { MONTH_GRID_CELLS, MONTH_GRID_ROWS, monthGrid, type MonthCell } from './monthGrid';
import { FRI, LAST_WED, MON, SAT, SUN, THU, WED } from '../../testing/fixtures';

// The window the fixtures' week opens with: 2026-07-13 to 2026-10-04.
const WINDOW: DayWindow = planningWindow(WED, 8);

/** Opens on a Saturday and runs 31 days, so August 2026 genuinely needs all six rows. */
const AUGUST = '2026-08-01';
/** Opens on a Sunday: 28 days over five rows. */
const FEB_2026 = '2026-02-01';
/** Opens on a Monday: 28 days over four rows, with no leading neighbour at all. */
const FEB_2027 = '2027-02-01';
/** Half of its grid falls behind the window's `minDate`. */
const JULY = '2026-07-01';
const JANUARY = '2026-01-01';
const OCTOBER = '2026-10-01';

function cellsOf(month: string, current?: string): MonthCell[] {
  return monthGrid(month, { today: WED, window: WINDOW, current });
}

function cellOf(month: string, date: string, current?: string): MonthCell {
  const cell = cellsOf(month, current).find((candidate) => candidate.date === date);
  if (cell === undefined) throw new Error(`${date} is not in the grid of ${month}`);
  return cell;
}

describe('the month grid', () => {
  it('is six rows of seven', () => {
    expect(MONTH_GRID_ROWS).toBe(6);
    expect(MONTH_GRID_CELLS).toBe(MONTH_GRID_ROWS * 7);
  });

  it('draws six Monday-first weeks of consecutive days, whatever the month', () => {
    for (const month of [AUGUST, FEB_2026, FEB_2027, JULY, JANUARY, '2026-11-01']) {
      const cells = cellsOf(month);
      expect(cells).toHaveLength(MONTH_GRID_CELLS);
      expect(weekdayOf(cells[0].date)).toBe(MONDAY);
      cells.forEach((cell, index) => {
        expect(cell.date).toBe(addDays(cells[0].date, index));
      });
    }
  });

  it('reads the month from any day of it', () => {
    expect(cellsOf('2026-08-25')).toEqual(cellsOf(AUGUST));
  });

  it('starts on the Monday before a month that opens on a Sunday', () => {
    const cells = cellsOf(FEB_2026);
    expect(cells[0].date).toBe('2026-01-26');
    expect(cells[0].inMonth).toBe(false);
    expect(cells[6].date).toBe(FEB_2026);
    expect(cells[6].inMonth).toBe(true);
  });

  it('starts on the 1st itself when the month opens on a Monday', () => {
    const cells = cellsOf(FEB_2027);
    expect(cells[0].date).toBe(FEB_2027);
    expect(cells[0].inMonth).toBe(true);
  });

  it('keeps its 42 cells for a month that fills six rows', () => {
    const cells = cellsOf(AUGUST);
    expect(cells).toHaveLength(MONTH_GRID_CELLS);
    expect(cells[0].date).toBe('2026-07-27');
    expect(cells[MONTH_GRID_CELLS - 1].date).toBe('2026-09-06');
    expect(cells.filter((cell) => cell.inMonth)).toHaveLength(31);
  });

  it('keeps its 42 cells for a February over five rows', () => {
    const cells = cellsOf(FEB_2026);
    expect(cells).toHaveLength(MONTH_GRID_CELLS);
    expect(cells[MONTH_GRID_CELLS - 1].date).toBe('2026-03-08');
    expect(cells.filter((cell) => cell.inMonth)).toHaveLength(28);
  });

  it('pads rather than shortens a February that fills four rows', () => {
    const cells = cellsOf(FEB_2027);
    expect(cells).toHaveLength(MONTH_GRID_CELLS);
    expect(cells.filter((cell) => cell.inMonth)).toHaveLength(28);
    // The last fourteen cells are all March, so a four-row month keeps the grid's height.
    expect(cells.slice(28).every((cell) => !cell.inMonth)).toBe(true);
    expect(cells[MONTH_GRID_CELLS - 1].date).toBe('2027-03-14');
  });

  it('marks the neighbour days that fill the first and the last row', () => {
    const neighbours = cellsOf(AUGUST)
      .filter((cell) => !cell.inMonth)
      .map((cell) => cell.date);
    expect(neighbours).toEqual([
      '2026-07-27',
      '2026-07-28',
      '2026-07-29',
      '2026-07-30',
      '2026-07-31',
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
      '2026-09-06',
    ]);
  });
});

describe('what the month grid offers', () => {
  it('offers every day of a month the window covers whole', () => {
    expect(cellsOf(AUGUST).every((cell) => cell.selectable)).toBe(true);
  });

  it('refuses the days before the window opens, though it draws them', () => {
    const refused = cellsOf(JULY)
      .filter((cell) => !cell.selectable)
      .map((cell) => cell.date);
    // 2026-06-29 to 2026-07-12: the fortnight of the July grid the window does not reach.
    expect(refused).toHaveLength(14);
    expect(refused[0]).toBe('2026-06-29');
    expect(refused[refused.length - 1]).toBe('2026-07-12');
    expect(cellOf(JULY, WINDOW.minDate).selectable).toBe(true);
  });

  it('refuses the days after the window closes', () => {
    expect(cellOf(OCTOBER, WINDOW.maxDate).selectable).toBe(true);
    expect(cellOf(OCTOBER, '2026-10-05').selectable).toBe(false);
  });

  it('offers the stored day itself, however far outside the window it falls', () => {
    expect(cellOf(JANUARY, '2026-01-09', '2026-01-09').selectable).toBe(true);
    // And only that day: the rest of its month stays as unreachable as before.
    expect(cellOf(JANUARY, '2026-01-08', '2026-01-09').selectable).toBe(false);
  });

  it('offers only what a window narrower than a month reaches', () => {
    const cells = monthGrid(AUGUST, { today: WED, window: { minDate: WED, maxDate: FRI } });
    expect(cells.filter((cell) => cell.selectable).map((cell) => cell.date)).toEqual([
      WED,
      THU,
      FRI,
    ]);
  });

  it('offers nothing but the stored day when the window is not a range', () => {
    const cells = monthGrid(AUGUST, {
      today: WED,
      window: { minDate: '', maxDate: '' },
      current: WED,
    });
    expect(cells.filter((cell) => cell.selectable).map((cell) => cell.date)).toEqual([WED]);
  });
});

describe('the marks the month grid decides without the server', () => {
  it('marks today, and only today', () => {
    expect(cellsOf(AUGUST).filter((cell) => cell.isToday).map((cell) => cell.date)).toEqual([WED]);
    expect(cellsOf(FEB_2027).some((cell) => cell.isToday)).toBe(false);
  });

  it('marks Saturday and Sunday', () => {
    expect(cellOf(AUGUST, SAT).isWeekend).toBe(true);
    expect(cellOf(AUGUST, SUN).isWeekend).toBe(true);
    expect(cellOf(AUGUST, MON).isWeekend).toBe(false);
    expect(cellsOf(AUGUST).filter((cell) => cell.isWeekend)).toHaveLength(12);
  });

  it('marks the days behind today, today itself not among them', () => {
    expect(cellOf(AUGUST, LAST_WED).isPast).toBe(true);
    expect(cellOf(AUGUST, MON).isPast).toBe(true);
    expect(cellOf(AUGUST, WED).isPast).toBe(false);
    expect(cellOf(AUGUST, THU).isPast).toBe(false);
    // The neighbour days of the first row are judged like any other day.
    expect(cellOf(AUGUST, '2026-07-27').isPast).toBe(true);
  });
});
