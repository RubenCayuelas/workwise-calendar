import { describe, expect, it } from 'vitest';
import { restoreDescription } from './restoreDescription';

const longDate = (date: string): string => `the ${date}`;

describe('what the confirmation before a restore says', () => {
  it('names the day and the hour of one of the weekly copies', () => {
    const description = restoreDescription(
      {
        kind: 'stored',
        backup: { name: 'workwise-2026-08-10-0900.db', date: '2026-08-10', time: '09:00', bytes: 1 },
      },
      longDate,
    );

    expect(description).toEqual({
      key: 'settings.backupsRestoreBody',
      values: { date: 'the 2026-08-10', time: '09:00' },
    });
  });

  it('names the update a pre-update copy comes from, which the weekly wording cannot', () => {
    const description = restoreDescription(
      {
        kind: 'preUpdate',
        backup: {
          name: 'workwise-before-update-2026-08-27-1430-0.26.0.db',
          date: '2026-08-27',
          time: '14:30',
          bytes: 1,
          version: '0.26.0',
        },
      },
      longDate,
    );

    expect(description).toEqual({
      key: 'settings.backupsRestoreUpdateBody',
      values: { date: 'the 2026-08-27', time: '14:30', version: '0.26.0' },
    });
  });

  it('names the file the owner chose, and never asks the formatter for a date it has not got', () => {
    const description = restoreDescription(
      { kind: 'file', file: { name: 'my copy.db' } as File },
      () => {
        throw new Error('a chosen file carries no calendar date');
      },
    );

    expect(description).toEqual({
      key: 'settings.backupsRestoreFileBody',
      values: { file: 'my copy.db' },
    });
  });
});
