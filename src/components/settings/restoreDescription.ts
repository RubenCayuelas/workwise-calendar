import type { StoredBackup, StoredPreUpdateBackup } from '../../lib/backups';

/** What the confirmation is about: one of the kept copies, or a file the owner just chose. */
export type PendingRestore =
  | { kind: 'stored'; backup: StoredBackup }
  | { kind: 'preUpdate'; backup: StoredPreUpdateBackup }
  | { kind: 'file'; file: File };

export interface RestoreDescription {
  key: string;
  values: Record<string, string>;
}

/**
 * `longDate` is only ever handed a `YYYY-MM-DD` from a copy's own name: it throws on anything else,
 * and a chosen file has no calendar date to give it.
 */
export function restoreDescription(
  pending: PendingRestore,
  longDate: (date: string) => string,
): RestoreDescription {
  if (pending.kind === 'file') {
    return { key: 'settings.backupsRestoreFileBody', values: { file: pending.file.name } };
  }

  const when = { date: longDate(pending.backup.date), time: pending.backup.time };
  return pending.kind === 'preUpdate'
    ? {
        key: 'settings.backupsRestoreUpdateBody',
        values: { ...when, version: pending.backup.version },
      }
    : { key: 'settings.backupsRestoreBody', values: when };
}
