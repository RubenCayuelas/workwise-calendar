'use client';

/**
 * `+ Nuevo trabajo`: name, description, colour, hours — the same four fields the job
 * panel edits, so creating and editing a job look identical.
 *
 * The one thing this screen has to get right is the consequence, because CLAUDE.md's
 * placement rule is not guessable: "A newly created job is appended after the last
 * existing block", "New job placement never targets Friday. A new job fills Mon-Thu;
 * if it does not fit, its tail goes to next week's Monday, skipping Friday entirely."
 *
 * So the consequence is shown twice:
 * - BEFORE saving, as the rule (`jobForm.hint`) plus the shop's current load, which is
 *   literally where the queue currently ends and therefore where this job starts.
 * - AFTER saving, as the rows the engine actually created — including, when it
 *   happens, the ones that landed in a later week and are therefore invisible on the
 *   week the owner is looking at.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconPlus } from '@tabler/icons-react';
import { Button, ColorDot, InlineBanner, SidePanel } from '../ui';
import {
  apiErrorMessage,
  createProject,
  type Block,
  type Project,
  type ScheduleSummary,
} from '../../lib/api-client';
import { hoursToMinutes, todayLocal } from '../../lib/dates';
import { PROJECT_COLORS } from '../../lib/projectColors';
import { useFormat } from '../../lib/useFormat';
import { JobFields, jobFieldErrors, type JobFieldName, type JobFormValues } from './JobFields';
import { PlacementNotice } from './PlacementNotice';
import { describePlacement, type PlacementOutcome } from './placement';
import { scheduleSummaryMessage } from './summary';
import type { JobsMutationHandler } from './events';
import styles from './jobs.module.css';

/** A day's work: the estimate the owner is most likely to adjust from, not to accept. */
const DEFAULT_HOURS = 8;

export interface NewJobPanelProps {
  open: boolean;
  onClose: () => void;
  /** Fired on success. The parent MUST refetch the week. */
  onChanged?: JobsMutationHandler;
  /**
   * The job that was created. The panel stays OPEN afterwards, showing where the hours
   * landed, so a parent that wants to open the job panel next should wait for `onClose`
   * — two panels share the same slot on the right.
   */
  onCreated?: (project: Project) => void;
  /**
   * `WeekView.summary`. Shown before saving as the answer to "where will this land":
   * the job is appended to the end of the queue, and this is where the queue ends.
   */
  summary?: ScheduleSummary;
  /** `WeekView.today`, so "a later week" means later than the week on screen. */
  today?: string;
  defaultHours?: number;
  /** Pre-selects a swatch — e.g. the colour the calendar sees least of. */
  defaultColor?: string;
}

export function NewJobPanel({
  open,
  onClose,
  onChanged,
  onCreated,
  summary,
  today,
  defaultHours = DEFAULT_HOURS,
  defaultColor = PROJECT_COLORS[0],
}: NewJobPanelProps): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const reference = today ?? todayLocal();

  const [values, setValues] = useState<JobFormValues>(() => blankJob(defaultHours, defaultColor));
  const [localErrors, setLocalErrors] = useState<Partial<Record<JobFieldName, string>>>({});
  const [actionError, setActionError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<{ blocks: Block[]; outcome: PlacementOutcome } | null>(null);

  // A fresh form every time the panel opens: the previous job is somebody else's.
  useEffect(() => {
    if (!open) return;
    setValues(blankJob(defaultHours, defaultColor));
    setLocalErrors({});
    setActionError(null);
    setCreated(null);
  }, [open, defaultHours, defaultColor]);

  const submit = async (): Promise<void> => {
    if (saving || created !== null) return;

    const name = values.name.trim();
    if (name === '') {
      setLocalErrors({ name: 'errors.invalidName' });
      return;
    }
    if (!(values.hours > 0)) {
      setLocalErrors({ hours: 'errors.invalidTotalHours' });
      return;
    }

    const description = values.description.trim();
    setSaving(true);
    setActionError(null);
    setLocalErrors({});

    try {
      const result = await createProject({
        name,
        ...(description === '' ? {} : { description }),
        color: values.color,
        totalMinutes: hoursToMinutes(values.hours),
      });

      // A job created is a job placed: every row is new, so the diff against nothing
      // is exactly "here is where the engine put it".
      setCreated({
        blocks: result.blocks,
        outcome: describePlacement([], result.blocks, reference),
      });
      onChanged?.({ kind: 'job-created', projectId: result.project.id, summary: result.summary });
      onCreated?.(result.project);
    } catch (error) {
      setActionError(error);
    } finally {
      setSaving(false);
    }
  };

  const actionMessage =
    actionError === null ? undefined : apiErrorMessage(actionError, t, format.language);
  const fieldErrors = jobFieldErrors(localErrors, actionError, t, actionMessage);
  const done = created !== null;

  return (
    <SidePanel
      open={open}
      onClose={onClose}
      title={t('jobForm.title')}
      accent={<ColorDot color={values.color} />}
      footer={
        done ? (
          <Button className={styles.grow} variant="primary" onClick={onClose}>
            {t('common.close')}
          </Button>
        ) : (
          <>
            <Button
              className={styles.grow}
              variant="primary"
              icon={<IconPlus size={15} stroke={1.75} />}
              disabled={saving}
              onClick={submit}
            >
              {saving ? t('common.saving') : t('jobForm.submit')}
            </Button>
            <Button variant="secondary" disabled={saving} onClick={onClose}>
              {t('jobForm.cancel')}
            </Button>
          </>
        )
      }
    >
      {actionMessage === undefined ? null : (
        <InlineBanner tone="error" title={t('errors.title')} onDismiss={() => setActionError(null)}>
          {actionMessage}
        </InlineBanner>
      )}

      {created === null ? null : (
        <PlacementNotice outcome={created.outcome} title={t('jobForm.created')} />
      )}

      <JobFields
        values={values}
        onChange={(next) => {
          setValues(next);
          setLocalErrors({});
          setActionError(null);
        }}
        errors={fieldErrors}
        disabled={saving || done}
        // Nothing to LIFO yet: on a new job the hours are simply the estimate.
        hoursHint={null}
      />

      {done ? null : (
        <>
          {summary === undefined ? null : (
            <div className={styles.context}>
              <span className={styles.contextLabel}>{t('summary.label')}</span>
              <span className={styles.contextValue}>
                {scheduleSummaryMessage(summary, t, format)}
              </span>
            </div>
          )}
          <p className={styles.hint}>{t('jobForm.hint')}</p>
        </>
      )}
    </SidePanel>
  );
}

function blankJob(hours: number, color: string): JobFormValues {
  return { name: '', description: '', hours, color };
}
