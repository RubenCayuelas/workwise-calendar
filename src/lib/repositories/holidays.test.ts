import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, openDatabase, type Db } from '../db';
import {
  findCachedHoliday,
  listCachedHolidays,
  readHolidayCheck,
  recordHolidayCheck,
  replaceCachedHolidays,
} from './holidays';

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
});

afterEach(() => {
  db.close();
  closeDb();
});

describe('the holiday cache', () => {
  it('is empty on a fresh calendar', () => {
    expect(listCachedHolidays(db)).toEqual([]);
    expect(readHolidayCheck(db)).toBeUndefined();
  });

  it('stores holidays in date order and finds one by its day', () => {
    replaceCachedHolidays(
      [
        { date: '2026-12-25', name: 'Natividad del Señor', level: 'national' },
        { date: '2026-09-03', name: 'Feria Real de Priego de Córdoba', level: 'local' },
      ],
      db,
    );

    expect(listCachedHolidays(db).map((holiday) => holiday.date)).toEqual(['2026-09-03', '2026-12-25']);
    expect(findCachedHoliday('2026-09-03', db)?.name).toBe('Feria Real de Priego de Córdoba');
    expect(findCachedHoliday('2026-09-04', db)).toBeUndefined();
  });

  it('REPLACES rather than merges, so a date that stopped being a holiday leaves the cache', () => {
    replaceCachedHolidays([{ date: '2026-06-04', name: 'Fiesta local', level: 'local' }], db);
    replaceCachedHolidays([{ date: '2026-06-11', name: 'Fiesta local', level: 'local' }], db);

    expect(listCachedHolidays(db).map((holiday) => holiday.date)).toEqual(['2026-06-11']);
  });

  it('keeps one check row, overwritten each time', () => {
    recordHolidayCheck({ municipality: '14055', checkedAt: '2026-08-25T09:00:00Z', succeeded: false }, db);
    recordHolidayCheck({ municipality: '14055', checkedAt: '2026-08-25T10:00:00Z', succeeded: true }, db);

    expect(readHolidayCheck(db)).toEqual({
      municipality: '14055',
      checkedAt: '2026-08-25T10:00:00Z',
      succeeded: true,
    });
  });
});
