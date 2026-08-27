import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  BEFORE_RESTORE_NAME,
  PRE_UPDATE_BACKUPS_KEPT,
  automaticBackupName,
  backupIsDue,
  backupsDirOf,
  inspectBackupFile,
  isNameableVersion,
  isRestorableName,
  listAutomaticBackups,
  listPreUpdateBackups,
  preUpdateBackupName,
  rotateBackups,
  rotatePreUpdateBackups,
  writeBackup,
  type StoredBackup,
  type StoredPreUpdateBackup,
} from '../backups';
import { closeDb, getDb, getDbPath, openDatabase } from '../db';
import { AppError, ERROR_MESSAGE_KEYS, badRequest } from '../errors';
import { readSettings } from '../settings';

export interface BackupList {
  /** Shown in Settings so the owner knows where the folder is on their own disk. */
  directory: string;
  backups: StoredBackup[];
  /**
   * The copies taken before an update, a SEPARATE field and not more of `backups`: the two series
   * rotate on their own counts, and a row that cannot say which it is cannot be acted on.
   */
  preUpdate: StoredPreUpdateBackup[];
}

export function listBackups(): BackupList {
  const directory = backupsDirOf(getDbPath());
  return {
    directory,
    backups: listAutomaticBackups(directory),
    preUpdate: listPreUpdateBackups(directory),
  };
}

export interface AutomaticBackupResult {
  created: string | null;
  removed: string[];
  /** Why nothing was created, so the caller can stay silent rather than guess. */
  skipped?: 'disabled' | 'not-due';
}

/**
 * Called once when the app is opened. Elapsed time and not a schedule: nothing runs while the app is
 * closed, so three weeks away owes ONE copy, not three.
 */
export function takeAutomaticBackup(now: Date = new Date()): AutomaticBackupResult {
  const settings = readSettings();
  if (!settings.backupsEnabled) return { created: null, removed: [], skipped: 'disabled' };

  const directory = backupsDirOf(getDbPath());
  const newest = listAutomaticBackups(directory)[0]?.name;
  if (!backupIsDue(newest, now, settings.backupEveryDays)) {
    return { created: null, removed: [], skipped: 'not-due' };
  }

  const name = automaticBackupName(now);
  writeBackup(getDb(), path.join(directory, name));
  return { created: name, removed: rotateBackups(directory, settings.backupsKept) };
}

export interface PreUpdateBackupResult {
  created: string;
  removed: string[];
}

/**
 * The way back from an update, taken while the calendar is still the one the OLD version wrote.
 *
 * `version` is the update about to install and reaches a filename, so it is refused unless it can
 * only be a version. Unconditional on purpose — `backupsEnabled` governs how much sits in the folder,
 * and an installed update cannot be undone, so switching the weekly copies off is not a decision to
 * update without a way back. The caller may not install unless this returns.
 */
export function takePreUpdateBackup(version: string, now: Date = new Date()): PreUpdateBackupResult {
  if (!isNameableVersion(version)) {
    throw badRequest('backup-version-invalid', ERROR_MESSAGE_KEYS.backupVersionInvalid, {
      field: 'version',
    });
  }

  const directory = backupsDirOf(getDbPath());
  const name = preUpdateBackupName(now, version);
  writeBackup(getDb(), path.join(directory, name));

  // An update that has downloaded but not installed is offered again every time the app opens, so the
  // same version arrives here more than once. Each attempt is the same update's way back, and the
  // later one is the fresher calendar, so it REPLACES the earlier rather than spending a slot: three
  // launches would otherwise erase every copy from before the version currently installed.
  const replaced = listPreUpdateBackups(directory)
    .filter((backup) => backup.version === version && backup.name !== name)
    .map((backup) => backup.name);
  for (const stale of replaced) fs.rmSync(path.join(directory, stale), { force: true });

  return {
    created: name,
    removed: [...replaced, ...rotatePreUpdateBackups(directory, PRE_UPDATE_BACKUPS_KEPT, name)],
  };
}

/**
 * A fresh copy in a temporary file for the caller to stream and then delete. Temporary because the
 * "save a copy" button writes wherever the owner points it, which is not this machine's business.
 */
export function exportBackup(now: Date = new Date()): { filePath: string; fileName: string } {
  const filePath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workwise-export-')),
    automaticBackupName(now),
  );
  writeBackup(getDb(), filePath);
  return { filePath, fileName: path.basename(filePath) };
}

export interface RestoreResult {
  /** The copy of the previous calendar this restore left behind, in the backups folder. */
  previousSavedAs: string;
}

/**
 * Replaces the calendar with a copy. ONE implementation for both ways in — a name from the folder and
 * a file from anywhere — so neither route can be the less tested one.
 *
 * Nothing is destroyed until the incoming file has been read, recognised and migrated; the previous
 * calendar is kept as `workwise-before-restore.db`, which the rotation never deletes.
 */
export function restoreBackup(source: { name: string } | { uploaded: Buffer }): RestoreResult {
  const dbPath = getDbPath();
  const directory = backupsDirOf(dbPath);

  const staged = path.join(directory, `.incoming-${process.pid}.db`);
  fs.mkdirSync(directory, { recursive: true });

  try {
    if ('name' in source) {
      const chosen = path.join(directory, path.basename(source.name));
      if (!isRestorableName(path.basename(source.name)) || !fs.existsSync(chosen)) {
        throw new AppError({
          code: 'backup-not-found',
          messageKey: ERROR_MESSAGE_KEYS.backupNotFound,
          status: 404,
        });
      }
      fs.copyFileSync(chosen, staged);
    } else {
      fs.writeFileSync(staged, source.uploaded);
    }

    const rejection = inspectBackupFile(staged);
    if (rejection !== null) {
      throw new AppError({
        code: rejection === 'not-sqlite' ? 'backup-not-a-database' : 'backup-not-workwise',
        messageKey:
          rejection === 'not-sqlite'
            ? ERROR_MESSAGE_KEYS.backupNotADatabase
            : ERROR_MESSAGE_KEYS.backupNotWorkwise,
        status: 400,
      });
    }

    // Bring an older copy forward before it becomes the live calendar, so restoring a backup taken by
    // a previous version of the app is what a backup is for rather than a broken database.
    migrateStagedFile(staged);

    // The last thing read from the calendar being replaced.
    writeBackup(getDb(), path.join(directory, BEFORE_RESTORE_NAME));

    closeDb();
    for (const sidecar of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${sidecar}`, { force: true });
    fs.renameSync(staged, dbPath);

    // The next `getDb()` opens the new file, runs its migrations and clears `history`: an undo must
    // not reach back into a calendar that no longer exists.
    return { previousSavedAs: BEFORE_RESTORE_NAME };
  } finally {
    // Opening the staged file put it in WAL mode; a clean close checkpoints the sidecars away, but a
    // failure part-way through would leave them next to a file that is about to be renamed.
    for (const sidecar of ['', '-wal', '-shm']) fs.rmSync(`${staged}${sidecar}`, { force: true });
  }
}

/** Opened through the app's own accessor, so the staged file gets the identical treatment. */
function migrateStagedFile(staged: string): void {
  openDatabase(staged).close();
}
