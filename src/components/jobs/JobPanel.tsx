'use client';

/**
 * The job panel. It fetches the job itself rather than taking the week's blocks, because the
 * list has to show EVERY row across every week.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, ColorDot, ConfirmDialog, InlineBanner, SidePanel, useToast } from '../ui';
import {
  apiErrorMessage,
  deleteProject,
  getProject,
  isAbortError,
  setBlockLock,
  updateProject,
  type Block,
  type Project,
  type UpdateProjectInput,
} from '../../lib/api-client';
import { hoursToMinutes, minutesToHours, todayLocal } from '../../lib/dates';
import { useFormat } from '../../lib/useFormat';
import { BlockRows } from './BlockRows';
import { JobFields, jobFieldErrors, type JobFieldName, type JobFormValues } from './JobFields';
import { PlacementNotice } from './PlacementNotice';
import { describePlacement, type PlacementOutcome } from './placement';
import type { JobsMutationHandler } from './events';
import styles from './jobs.module.css';

export interface JobPanelProps {
  open: boolean;
  /** The job to edit. Changing it while open reloads the panel. */
  projectId: string;
  onClose: () => void;
  /** Fired after every successful write. The parent MUST refetch the week. */
  onChanged?: JobsMutationHandler;
  /** After the job and its rows are gone. `onChanged` fires first, then the panel closes. */
  onDeleted?: (projectId: string) => void;
  /**
   * Opens the split form for one row. Adds the scissors to each row of the list —
   * the only way to reach a row that is not in the week on screen.
   */
  onSplitBlock?: (block: Block) => void;
  /** `WeekView.today`. Dims the frozen past and anchors the "later week" test. */
  today?: string;
}

export function JobPanel({
  open,
  projectId,
  onClose,
  onChanged,
  onDeleted,
  onSplitBlock,
  today,
}: JobPanelProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const format = useFormat();
  const reference = today ?? todayLocal();

  const [project, setProject] = useState<Project | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [values, setValues] = useState<JobFormValues | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // Errors are kept as THROWN OBJECTS, not as sentences: the message is built at
  // render time, so switching language re-translates a failure already on screen.
  const [loadError, setLoadError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [localErrors, setLocalErrors] = useState<Partial<Record<JobFieldName, string>>>({});

  const [notice, setNotice] = useState<{ outcome: PlacementOutcome; touched: string[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [lockBusyId, setLockBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      // A confirmation must never outlive the panel it belongs to.
      setConfirmOpen(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    setActionError(null);
    setLocalErrors({});
    setNotice(null);

    getProject(projectId, { signal: controller.signal })
      .then((detail) => {
        if (controller.signal.aborted) return;
        setProject(detail.project);
        setBlocks(detail.blocks);
        setValues(valuesOf(detail.project));
      })
      .catch((error: unknown) => {
        if (isAbortError(error) || controller.signal.aborted) return;
        setLoadError(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [open, projectId, reloadKey]);

  const edit = useCallback((next: JobFormValues) => {
    setValues(next);
    // The notice describes the state as it was saved; any keystroke makes it stale.
    setNotice(null);
    setLocalErrors({});
    setActionError(null);
  }, []);

  /**
   * The loaded job, but only while it IS the job the panel was asked for: opening the panel
   * on another job keeps the previous one in state until the fetch resolves, and rendering
   * that would show the wrong name and rows for a moment.
   */
  const loaded = project !== null && project.id === projectId ? project : null;

  const dirty = loaded !== null && values !== null && !sameValues(values, valuesOf(loaded));

  const save = async (): Promise<void> => {
    const project = loaded;
    if (project === null || values === null || saving) return;

    const name = values.name.trim();
    if (name === '') {
      setLocalErrors({ name: 'errors.invalidName' });
      return;
    }
    if (!(values.hours > 0)) {
      setLocalErrors({ hours: 'errors.invalidTotalHours' });
      return;
    }

    const patch = patchOf(project, { ...values, name });
    if (Object.keys(patch).length === 0) {
      // Only whitespace changed. Snap the form back so it stops looking dirty.
      setValues(valuesOf(project));
      return;
    }

    setSaving(true);
    setActionError(null);
    setLocalErrors({});

    try {
      const result = await updateProject(project.id, patch);
      setProject(result.project);
      setBlocks(result.blocks);
      setValues(valuesOf(result.project));
      setNotice({
        outcome: describePlacement(blocks, result.blocks, reference),
        touched: result.touchedLockedBlockIds,
      });
      onChanged?.({ kind: 'job-updated', projectId: result.project.id, summary: result.summary });
    } catch (error) {
      setActionError(error);
    } finally {
      setSaving(false);
    }
  };

  const toggleLock = async (block: Block): Promise<void> => {
    if (lockBusyId !== null) return;
    setLockBusyId(block.id);
    setActionError(null);

    try {
      const result = await setBlockLock(block.id, !block.locked);
      setBlocks(result.blocks);
      // No placement notice on purpose: locking reflows the whole calendar, so a list of
      // everything that moved would be noise rather than news.
      onChanged?.({
        kind: 'block-locked',
        projectId: block.projectId,
        blockId: block.id,
        summary: result.summary,
      });
    } catch (error) {
      setActionError(error);
    } finally {
      setLockBusyId(null);
    }
  };

  const remove = async (): Promise<void> => {
    const project = loaded;
    if (project === null || deleting) return;
    setDeleting(true);
    setActionError(null);

    try {
      // The language is part of the request: the server composes each preserved gap's
      // `reason` at deletion time and stores it.
      const result = await deleteProject(project.id, { language: i18n.language });
      onChanged?.({ kind: 'job-deleted', projectId: project.id, summary: result.summary });
      // Said only when there IS a past to have kept: on a job entirely in the future the
      // calendar closing up is the whole story.
      if (result.preservedGapIds.length > 0) {
        toast.info(t('notices.deletedJobPast', { count: result.preservedGapIds.length }));
      }
      onDeleted?.(project.id);
      setConfirmOpen(false);
      onClose();
    } catch (error) {
      setConfirmOpen(false);
      setActionError(error);
    } finally {
      setDeleting(false);
    }
  };

  const actionMessage =
    actionError === null ? undefined : apiErrorMessage(actionError, t, format.language);
  const fieldErrors = jobFieldErrors(localErrors, actionError, t, actionMessage);
  const busy = saving || deleting;
  const ready = loaded !== null && values !== null;
  // The header follows the field as it is typed, so a rename is visible before saving.
  const headerTitle =
    ready && values.name.trim() !== '' ? values.name : t('jobPanel.title');

  return (
    <>
      <SidePanel
        open={open}
        onClose={onClose}
        // Escape must not close the panel from underneath the confirmation: both
        // listen on `document`, so the dialog cannot stop this one on its own.
        closeOnEscape={!confirmOpen}
        title={headerTitle}
        accent={ready ? <ColorDot color={values.color} /> : undefined}
        closeLabel={t('jobPanel.close')}
        footer={
          !ready ? undefined : (
            <>
              <Button className={styles.grow} variant="primary" disabled={!dirty || busy} onClick={save}>
                {saving ? t('common.saving') : t('jobPanel.save')}
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => setConfirmOpen(true)}>
                {t('jobPanel.delete')}
              </Button>
            </>
          )
        }
      >
        {loadError !== null ? (
          <InlineBanner
            tone="error"
            title={t('errors.title')}
            onRetry={() => setReloadKey((key) => key + 1)}
          >
            {apiErrorMessage(loadError, t, format.language)}
          </InlineBanner>
        ) : null}

        {loading && !ready ? <p className={styles.loading}>{t('common.loading')}</p> : null}

        {!ready ? null : (
          <>
            {actionMessage === undefined ? null : (
              <InlineBanner tone="error" title={t('errors.title')} onDismiss={() => setActionError(null)}>
                {actionMessage}
              </InlineBanner>
            )}

            {notice === null ? null : (
              <PlacementNotice
                outcome={notice.outcome}
                title={t('jobPanel.saved')}
                touchedLockedBlockIds={notice.touched}
                onDismiss={() => setNotice(null)}
              />
            )}

            <JobFields values={values} onChange={edit} errors={fieldErrors} disabled={busy} />

            {dirty ? <p className={styles.hint}>{t('jobPanel.unsavedChanges')}</p> : null}

            <BlockRows
              blocks={blocks}
              today={reference}
              onToggleLock={toggleLock}
              onSplit={onSplitBlock}
              busyBlockId={lockBusyId}
              disabled={busy}
            />
          </>
        )}
      </SidePanel>

      <ConfirmDialog
        open={confirmOpen && loaded !== null}
        title={t('jobPanel.deleteTitle', { name: loaded?.name ?? '' })}
        description={t('jobPanel.deleteBody', { count: blocks.length })}
        confirmLabel={t('jobPanel.deleteConfirm')}
        busy={deleting}
        onConfirm={remove}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Form <-> job
// ---------------------------------------------------------------------------

function valuesOf(project: Project): JobFormValues {
  return {
    name: project.name,
    description: project.description ?? '',
    hours: minutesToHours(project.totalMinutes),
    color: project.color,
  };
}

function sameValues(a: JobFormValues, b: JobFormValues): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.hours === b.hours &&
    a.color.toUpperCase() === b.color.toUpperCase()
  );
}

/**
 * Only what actually changed. Restating every field would be harmless for the name and the
 * colour but not for the hours: `totalMinutes` is the LIFO path, and re-sending the same
 * total is a no-op the engine should never be asked to consider. `null` clears a description.
 */
function patchOf(project: Project, values: JobFormValues): UpdateProjectInput {
  const patch: UpdateProjectInput = {};

  if (values.name !== project.name) patch.name = values.name;

  const description = values.description.trim();
  if (description !== (project.description ?? '')) {
    patch.description = description === '' ? null : description;
  }

  if (values.color.toUpperCase() !== project.color.toUpperCase()) patch.color = values.color;

  const totalMinutes = hoursToMinutes(values.hours);
  if (totalMinutes !== project.totalMinutes) patch.totalMinutes = totalMinutes;

  return patch;
}
