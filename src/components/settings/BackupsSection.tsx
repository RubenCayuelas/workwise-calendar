'use client';

/**
 * The backups block of the Settings screen. The three preferences belong to the parent's draft and
 * its Save button; the buttons and the list act on their own, because a copy is not a preference.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconDownload, IconUpload } from '@tabler/icons-react';
import { Button, Checkbox, ConfirmDialog, Field, InlineBanner, NumberStepper } from '../ui';
import { useLanguage } from '../I18nProvider';
import {
  apiErrorMessage,
  fetchBackupBytes,
  isAbortError,
  isApiError,
  listBackups,
  restoreBackupByName,
  restoreBackupFile,
} from '../../lib/api-client';
import { instantToLocalStamp } from '../../lib/dates';
import { useFormat } from '../../lib/useFormat';
import type { StoredBackup, StoredPreUpdateBackup } from '../../lib/backups';
import type { Settings } from '../../types';
import { restoreDescription, type PendingRestore } from './restoreDescription';
import {
  BACKUPS_KEPT_MAX,
  BACKUPS_KEPT_MIN,
  BACKUP_DAYS_MAX,
  BACKUP_DAYS_MIN,
} from './shift';
import styles from './SettingsScreen.module.css';

interface BackupsSectionProps {
  draft: Settings;
  patchDraft: (patch: Partial<Settings>) => void;
  errorFor: (field: keyof Settings) => string | undefined;
}

/** Survives the reload a restore triggers, so its confirmation is not lost with the page. */
const RESTORED_KEY = 'workwise.backupRestored';

export function BackupsSection({
  draft,
  patchDraft,
  errorFor,
}: BackupsSectionProps): React.JSX.Element {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const format = useFormat();

  const [directory, setDirectory] = useState('');
  const [backups, setBackups] = useState<StoredBackup[]>([]);
  const [preUpdate, setPreUpdate] = useState<StoredPreUpdateBackup[]>([]);
  const [pending, setPending] = useState<PendingRestore | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [outcome, setOutcome] = useState<string | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const list = await listBackups({ signal });
      setDirectory(list.directory);
      setBackups(list.backups);
      setPreUpdate(list.preUpdate);
    } catch (error) {
      if (!isAbortError(error)) setFailure(error);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  // The other half of the restore: read once, so it does not reappear on the next visit.
  useEffect(() => {
    const restored = window.sessionStorage.getItem(RESTORED_KEY);
    if (restored === null) return;
    window.sessionStorage.removeItem(RESTORED_KEY);
    setOutcome(t('notices.backupRestored', { name: restored }));
  }, [t]);

  const save = useCallback(async () => {
    setFailure(undefined);
    const suggested = `workwise-${instantToLocalStamp(new Date())}.db`;
    try {
      // The picker has to be reached from the click itself, so it comes before the request.
      const handle = await openSaveDialog(suggested);
      const bytes = await fetchBackupBytes();
      if (handle === undefined) {
        downloadInstead(bytes, suggested);
      } else {
        const writable = await handle.createWritable();
        await writable.write(bytes);
        await writable.close();
      }
      // Which of the two happened matters: the fallback puts the file in the browser's download
      // folder, NOT where the owner pointed, and saying "saved" would be a half-truth.
      setOutcome(
        handle === undefined
          ? t('settings.backupDownloaded', { file: suggested })
          : t('settings.backupSaved', { file: suggested }),
      );
    } catch (error) {
      // Closing the native dialog is a decision, not a failure.
      if (isAbortError(error) || isCancelledPicker(error)) return;
      setFailure(error);
    }
  }, [t]);

  const restore = useCallback(
    async (request: PendingRestore) => {
      setBusy(true);
      setFailure(undefined);
      try {
        const result =
          request.kind === 'file'
            ? await restoreBackupFile(request.file)
            : await restoreBackupByName(request.backup.name);
        setPending(undefined);
        // Handed across the reload: a toast raised here would be destroyed by it, which is the same
        // silence the save had.
        window.sessionStorage.setItem(RESTORED_KEY, result.previousSavedAs);
        // The whole calendar changed underneath every screen, so nothing in memory is still true.
        window.location.reload();
      } catch (error) {
        setPending(undefined);
        setFailure(error);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const confirmation =
    pending === undefined
      ? undefined
      : restoreDescription(pending, (date) => format.longDate(date));

  return (
    <section className={`ww-card ${styles.section}`}>
      <h2 className={styles.sectionTitle}>{t('settings.backupsSection')}</h2>
      {directory === '' ? null : (
        <p className={styles.sectionHint}>{t('settings.backupsHint', { directory })}</p>
      )}

      <div className={styles.rows}>
        <div className={styles.row}>
          <Checkbox
            label={t('settings.backupsEnabled')}
            hint={t('settings.backupsEnabledHint')}
            checked={draft.backupsEnabled}
            onChange={(event) => patchDraft({ backupsEnabled: event.target.checked })}
          />
        </div>

        <Field
          label={t('settings.backupEveryDays')}
          inline
          hint={t('settings.backupEveryDaysHint', { min: BACKUP_DAYS_MIN, max: BACKUP_DAYS_MAX })}
          error={errorFor('backupEveryDays')}
        >
          <NumberStepper
            value={draft.backupEveryDays}
            onChange={(value) => patchDraft({ backupEveryDays: value })}
            min={BACKUP_DAYS_MIN}
            max={BACKUP_DAYS_MAX}
            step={1}
            disabled={!draft.backupsEnabled}
          />
        </Field>

        <Field
          label={t('settings.backupsKept')}
          inline
          hint={t('settings.backupsKeptHint')}
          error={errorFor('backupsKept')}
        >
          <NumberStepper
            value={draft.backupsKept}
            onChange={(value) => patchDraft({ backupsKept: value })}
            min={BACKUPS_KEPT_MIN}
            max={BACKUPS_KEPT_MAX}
            step={1}
            disabled={!draft.backupsEnabled}
          />
        </Field>

        <div className={styles.row}>
          <span className="ww-small ww-muted">{t('settings.backupsList')}</span>
          {backups.length === 0 ? (
            <p className={styles.note}>{t('settings.backupsListEmpty')}</p>
          ) : (
            <ul className={styles.backupList}>
              {backups.map((backup) => (
                <li key={backup.name} className={styles.backupRow}>
                  <span className="ww-tabular">
                    {format.mediumDate(backup.date)} · {backup.time}
                  </span>
                  <span className="ww-small ww-muted ww-tabular">{kilobytes(backup.bytes)}</span>
                  <span className="ww-spacer" />
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => setPending({ kind: 'stored', backup })}
                  >
                    {t('settings.backupsRestore')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className={styles.row}>
          <span className="ww-small ww-muted">{t('settings.backupsBeforeUpdate')}</span>
          {preUpdate.length === 0 ? (
            <p className={styles.note}>{t('settings.backupsBeforeUpdateEmpty')}</p>
          ) : (
            <ul className={styles.backupList}>
              {preUpdate.map((backup) => (
                <li key={backup.name} className={styles.backupRow}>
                  <span className="ww-tabular">
                    {format.mediumDate(backup.date)} · {backup.time}
                  </span>
                  <span className="ww-small ww-muted">
                    {t('settings.backupsBeforeUpdateVersion', { version: backup.version })}
                  </span>
                  <span className="ww-spacer" />
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => setPending({ kind: 'preUpdate', backup })}
                  >
                    {t('settings.backupsRestore')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {outcome === undefined ? null : (
          <InlineBanner tone="success" onDismiss={() => setOutcome(undefined)}>
            {outcome}
          </InlineBanner>
        )}

        {failure === undefined ? null : (
          <InlineBanner
            tone="error"
            title={t('errors.title')}
            onDismiss={() => setFailure(undefined)}
          >
            {isApiError(failure) ? apiErrorMessage(failure, t, language) : t('errors.unexpected')}
          </InlineBanner>
        )}

        <div className={styles.backupActions}>
          <Button
            variant="secondary"
            icon={<IconDownload size={15} stroke={1.75} />}
            onClick={() => void save()}
          >
            {t('settings.backupsSave')}
          </Button>
          <Button
            variant="ghost"
            icon={<IconUpload size={15} stroke={1.75} />}
            onClick={() => fileInput.current?.click()}
          >
            {t('settings.backupsLoad')}
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".db,application/vnd.sqlite3,application/octet-stream"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Cleared so choosing the same file twice still fires a change.
              event.target.value = '';
              if (file !== undefined) setPending({ kind: 'file', file });
            }}
          />
        </div>
      </div>

      <ConfirmDialog
        open={pending !== undefined}
        title={t('settings.backupsRestoreTitle')}
        danger
        busy={busy}
        busyLabel={t('common.saving')}
        confirmLabel={t('settings.backupsRestoreConfirm')}
        onCancel={() => setPending(undefined)}
        onConfirm={() => {
          if (pending !== undefined) void restore(pending);
        }}
        description={confirmation === undefined ? undefined : t(confirmation.key, confirmation.values)}
      />
    </section>
  );
}

function kilobytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} kB`;
}

/**
 * The native "Save as" window, where the browser has one. Chrome does and this app is Chrome on a
 * shop PC; anywhere else the caller falls back to an ordinary download, which cannot choose a folder.
 */
interface FileHandle {
  createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }>;
}

async function openSaveDialog(suggestedName: string): Promise<FileHandle | undefined> {
  // CALLED AS A METHOD, never through a local copy: a WebIDL function invoked without its receiver
  // throws "Illegal invocation" in Chrome. It is also absent unless the page is a secure context, so
  // reaching the app by IP rather than by localhost lands on the download instead.
  const host = window as unknown as {
    showSaveFilePicker?: (options: unknown) => Promise<FileHandle>;
  };
  if (typeof host.showSaveFilePicker !== 'function') return undefined;
  return host.showSaveFilePicker({
    suggestedName,
    types: [{ description: 'Workwise', accept: { 'application/vnd.sqlite3': ['.db'] } }],
  });
}

function downloadInstead(bytes: Blob, fileName: string): void {
  const url = URL.createObjectURL(bytes);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  // Revoked on a later tick: doing it in this one can cut the download off before it starts.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** `showSaveFilePicker` rejects with an AbortError when the owner closes the dialog. */
function isCancelledPicker(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
