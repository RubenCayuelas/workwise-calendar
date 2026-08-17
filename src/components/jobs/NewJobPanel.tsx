'use client';

/**
 * `+ Nuevo trabajo`: name, description, colour, hours — the same four fields the job
 * panel edits, so creating and editing a job look identical — plus an OPTIONAL START
 * DATE.
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
 *
 * THE START DATE means "not before this day" — a floor, never a deadline. Choosing one
 * turns the first half of that promise into a real preview: `POST /api/projects/preview`
 * runs the SAME planner the save runs (`src/lib/creation.ts`), so the panel can say which
 * day the hours will really start on, what is already sitting across the whole span they
 * would occupy, and whether every row will come back locked — before anything is written.
 * Then the owner picks another day (the free ones are listed), forces it, or accepts it.
 *
 * Two gates are deliberately local rather than taken from the preview:
 * - the Friday/weekend CONFIRMATION, because it depends only on the weekday and a save
 *   must never honour one of those days silently just because a preview request failed;
 * - `force`, which is reset by every change of date, since it is an answer to one
 *   specific question about one specific day.
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconPlus } from '@tabler/icons-react';
import {
  Button,
  Checkbox,
  ColorDot,
  ConfirmDialog,
  DateSelect,
  Field,
  InlineBanner,
  SidePanel,
} from '../ui';
import {
  apiErrorMessage,
  createProject,
  isAbortError,
  previewProjectCreation,
  type Block,
  type CreationOutcome,
  type CreationPreview,
  type Project,
  type ScheduleSummary,
} from '../../lib/api-client';
import { FRIDAY, hoursToMinutes, isValidDate, isWeekend, todayLocal, weekdayOf } from '../../lib/dates';
import { PROJECT_COLORS } from '../../lib/projectColors';
import { useFormat, type Formatter } from '../../lib/useFormat';
import { JobFields, jobFieldErrors, type JobFieldName, type JobFormValues } from './JobFields';
import { PlacementNotice } from './PlacementNotice';
import { describePlacement, type PlacementOutcome } from './placement';
import { summarizeStartDate, type StartDateNote, type StartDateSummary } from './startDate';
import { scheduleSummaryMessage } from './summary';
import type { JobsMutationHandler } from './events';
import styles from './jobs.module.css';

/** A day's work: the estimate the owner is most likely to adjust from, not to accept. */
const DEFAULT_HOURS = 8;

/**
 * How long the form waits before asking the server where the job would land. The hours
 * stepper fires on every click, and a preview per click would be a request per click.
 */
const PREVIEW_DELAY_MS = 220;

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
  /** `settings.planningHorizonWeeks`: how far ahead the day picker reaches. */
  horizonWeeks?: number;
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
  horizonWeeks,
}: NewJobPanelProps): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const reference = today ?? todayLocal();

  const [values, setValues] = useState<JobFormValues>(() => blankJob(defaultHours, defaultColor));
  const [localErrors, setLocalErrors] = useState<Partial<Record<JobFieldName, string>>>({});
  const [actionError, setActionError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<{
    blocks: Block[];
    outcome: PlacementOutcome;
    /** Present when the job named a start date: what the date turned out to mean. */
    placement?: CreationOutcome;
  } | null>(null);

  const [dated, setDated] = useState(false);
  const [startDate, setStartDate] = useState(reference);
  const [force, setForce] = useState(false);
  const [preview, setPreview] = useState<CreationPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<unknown>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const done = created !== null;

  /**
   * A fresh form every time the panel OPENS — on the opening edge only.
   *
   * Not on a change of the defaults, which is what it used to do, and driving the panel
   * is what showed why: `defaultColor` is the swatch the calendar shows least of, so
   * creating a job changes it, so the parent's refetch handed this panel a new default
   * and the effect wiped the form — including the "where the hours went" notice the
   * owner had just earned, half a second after it appeared.
   */
  const initialised = useRef(false);
  useEffect(() => {
    if (!open) {
      initialised.current = false;
      setConfirmOpen(false);
      return;
    }
    if (initialised.current) return;
    initialised.current = true;
    setValues(blankJob(defaultHours, defaultColor));
    setLocalErrors({});
    setActionError(null);
    setCreated(null);
    setDated(false);
    setStartDate(reference);
    setForce(false);
    setPreview(null);
    setPreviewError(null);
  }, [open, defaultHours, defaultColor, reference]);

  const previewable = open && !done && dated && isValidDate(startDate) && values.hours > 0;

  useEffect(() => {
    if (!previewable) {
      setPreview(null);
      setPreviewError(null);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setPreviewing(true);
      previewProjectCreation(
        { startDate, totalMinutes: hoursToMinutes(values.hours), force },
        { signal: controller.signal },
      )
        .then((result) => {
          if (cancelled) return;
          setPreview(result);
          setPreviewError(null);
        })
        .catch((error: unknown) => {
          if (cancelled || isAbortError(error)) return;
          setPreview(null);
          setPreviewError(error);
        })
        .finally(() => {
          if (!cancelled) setPreviewing(false);
        });
    }, PREVIEW_DELAY_MS);

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [previewable, startDate, values.hours, force]);

  const startSummary: StartDateSummary | null =
    preview === null ? null : summarizeStartDate(preview);

  // The weekday alone decides this, so it never depends on a request having succeeded.
  const dayConfirmKind = !dated || !isValidDate(startDate) ? null : confirmKindOf(startDate);

  const save = async (): Promise<void> => {
    setConfirmOpen(false);
    setSaving(true);
    setActionError(null);
    setLocalErrors({});

    const description = values.description.trim();

    try {
      const result = await createProject({
        name: values.name.trim(),
        ...(description === '' ? {} : { description }),
        color: values.color,
        totalMinutes: hoursToMinutes(values.hours),
        ...(dated ? { startDate, force } : {}),
      });

      // A job created is a job placed: every row is new, so the diff against nothing
      // is exactly "here is where the engine put it".
      setCreated({
        blocks: result.blocks,
        outcome: describePlacement([], result.blocks, reference),
        ...(result.placement === undefined ? {} : { placement: result.placement }),
      });
      onChanged?.({ kind: 'job-created', projectId: result.project.id, summary: result.summary });
      onCreated?.(result.project);
    } catch (error) {
      setActionError(error);
    } finally {
      setSaving(false);
    }
  };

  const submit = async (): Promise<void> => {
    if (saving || done) return;

    if (values.name.trim() === '') {
      setLocalErrors({ name: 'errors.invalidName' });
      return;
    }
    if (!(values.hours > 0)) {
      setLocalErrors({ hours: 'errors.invalidTotalHours' });
      return;
    }
    if (dated && !isValidDate(startDate)) {
      setActionError(null);
      setLocalErrors({});
      return;
    }

    // The buffer and the weekend are honoured — after the owner says so out loud.
    if (dayConfirmKind !== null) {
      setConfirmOpen(true);
      return;
    }

    await save();
  };

  const actionMessage =
    actionError === null ? undefined : apiErrorMessage(actionError, t, format.language);
  const previewMessage =
    previewError === null ? undefined : apiErrorMessage(previewError, t, format.language);
  const fieldErrors = jobFieldErrors(localErrors, actionError, t, actionMessage);

  return (
    <>
      <SidePanel
        open={open}
        onClose={onClose}
        closeOnEscape={!confirmOpen}
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
          <>
            <PlacementNotice outcome={created.outcome} title={t('jobForm.created')} />
            {/* The marks the date left on the rows. They are visible on the calendar as
                glyphs, but the owner is looking at this panel, and a padlock nobody
                asked for is exactly the thing to explain where it was decided. */}
            {created.placement?.autoLock === true ? (
              <p className={styles.hint}>{t('jobForm.createdLocked')}</p>
            ) : null}
            {created.placement?.dayLock === true && created.placement.autoLock !== true ? (
              <p className={styles.hint}>{t('jobForm.createdDayLocked')}</p>
            ) : null}
          </>
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
            <Checkbox
              label={t('jobForm.startLabel')}
              hint={t('jobForm.startHint')}
              checked={dated}
              disabled={saving}
              onChange={(event) => {
                setDated(event.target.checked);
                setForce(false);
                setPreview(null);
                setPreviewError(null);
              }}
            />

            {!dated ? null : (
              <>
                {/* The day is CHOSEN from the schedule's own days, spelled by
                    `useFormat()` and grouped under the week label the header shows —
                    never a native date input, which would draw its parts in the
                    BROWSER's locale. The window reaches back a few weeks on purpose:
                    a past date records a job that was done but never logged. */}
                <Field
                  label={t('jobForm.startDate')}
                  hint={isValidDate(startDate) ? format.longDate(startDate) : undefined}
                >
                  <DateSelect
                    value={startDate}
                    today={reference}
                    horizonWeeks={horizonWeeks}
                    disabled={saving}
                    onChange={(next) => {
                      setStartDate(next);
                      // A new day is a new question; the old answer must not carry over.
                      setForce(false);
                    }}
                  />
                </Field>

                <StartDatePreview
                  summary={startSummary}
                  loading={previewing && startSummary === null}
                  message={previewMessage}
                  chosenDate={startDate}
                  lastOccupiedDate={preview?.lastOccupiedDate ?? null}
                  format={format}
                  t={t}
                />

                {startSummary?.canForce === true || force ? (
                  <Checkbox
                    label={t('jobForm.startForce')}
                    hint={t('jobForm.startForceHint')}
                    checked={force}
                    disabled={saving}
                    onChange={(event) => setForce(event.target.checked)}
                  />
                ) : null}
              </>
            )}

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

      <ConfirmDialog
        open={confirmOpen && dayConfirmKind !== null}
        title={t(
          dayConfirmKind === 'weekend' ? 'jobForm.confirmWeekendTitle' : 'jobForm.confirmBufferTitle',
        )}
        description={
          isValidDate(startDate)
            ? t(dayConfirmKind === 'weekend' ? 'jobForm.confirmWeekendBody' : 'jobForm.confirmBufferBody', {
                date: format.longDate(startDate),
              })
            : undefined
        }
        confirmLabel={t('jobForm.confirmDay')}
        busy={saving}
        onConfirm={save}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// The preview
// ---------------------------------------------------------------------------

interface StartDatePreviewProps {
  summary: StartDateSummary | null;
  loading: boolean;
  /** A failed preview request, already translated. */
  message?: string;
  chosenDate: string;
  lastOccupiedDate: string | null;
  format: Formatter;
  t: (key: string, values?: Record<string, unknown>) => string;
}

/**
 * The rows the job would be born as, then the notes, then what is in the way.
 *
 * All of the deciding happened in `summarizeStartDate`; this only spells it. The notes
 * are KINDS rather than strings so that this switch is the single place a sentence about
 * the start date is chosen, and every day and hour in it goes through `useFormat()`.
 */
function StartDatePreview({
  summary,
  loading,
  message,
  chosenDate,
  lastOccupiedDate,
  format,
  t,
}: StartDatePreviewProps): React.JSX.Element | null {
  if (message !== undefined) {
    return (
      <InlineBanner tone="error" title={t('errors.title')}>
        {message}
      </InlineBanner>
    );
  }
  if (summary === null) {
    return loading ? <p className={styles.hint}>{t('jobForm.startPreviewLoading')}</p> : null;
  }

  const note = (kind: StartDateNote): string => {
    switch (kind) {
      case 'deferred':
        return t('jobForm.startDeferred', {
          chosen: format.mediumDate(chosenDate),
          date: summary.startsOn === null ? '' : format.longDate(summary.startsOn),
          until: lastOccupiedDate === null ? '' : format.mediumDate(lastOccupiedDate),
        });
      case 'forced':
        return t('jobForm.startForced', { date: format.longDate(chosenDate) });
      case 'autoLock':
        return t('jobForm.startAutoLock');
      case 'buffer':
        return t('jobForm.startBuffer');
      case 'weekend':
        return t('jobForm.startWeekend');
      case 'past':
        return t('jobForm.startPast');
      case 'closed':
        return t('jobForm.startClosed');
      case 'lockedStands':
        return t('jobForm.startLockedStands');
      case 'clear':
        return t('jobForm.startClear');
      case 'freeDays':
        return t('jobForm.startFreeDays', {
          days: summary.freeDates.map((date) => format.dayOption(date)).join(', '),
        });
    }
  };

  return (
    <div className={styles.notices}>
      <InlineBanner tone={summary.tone} title={t('jobForm.startPreviewTitle')}>
        {summary.startsOn === null ? (
          t('jobForm.startNothing')
        ) : (
          <>
            <span className={styles.noticeList}>
              {summary.rows.map((row) => (
                <span key={`${row.date}-${row.startMinutes}`} className={styles.noticeLine}>
                  <span className={styles.noticeLabel}>
                    {format.dayTimeHours(row.date, row.startMinutes, row.durationMinutes)}
                  </span>
                  {row.locked ? <span className={styles.blockTag}>{t('block.locked')}</span> : null}
                </span>
              ))}
              {summary.moreRows > 0 ? (
                <span className={styles.noticeLine}>
                  {t('jobForm.startMoreRows', { count: summary.moreRows })}
                </span>
              ) : null}
            </span>

            <span className={styles.previewNotes}>
              {summary.notes.map((kind) => (
                <span key={kind} className={styles.hint}>
                  {note(kind)}
                </span>
              ))}
              {summary.collisions.length === 0 ? null : (
                <span className={styles.hint}>
                  {t('jobForm.startCollisions', {
                    count: summary.collisionJobs,
                    hours: format.hourNumber(summary.collisionMinutes),
                  })}
                </span>
              )}
            </span>

            {summary.collisions.length === 0 ? null : (
              <>
                <span className={styles.noticeList}>
                  {summary.collisions.map((collision) => (
                    <span key={collision.key} className={styles.noticeLine}>
                      <span className={styles.noticeLabel}>
                        {t('jobForm.startCollisionRow', {
                          day: format.dayOption(collision.date),
                          hours: format.hourNumber(collision.minutes),
                        })}
                      </span>
                      {collision.projectName === '' ? null : (
                        <span className={styles.blockTag}>{collision.projectName}</span>
                      )}
                      {collision.locked ? (
                        <span className={styles.blockTag}>{t('block.locked')}</span>
                      ) : null}
                    </span>
                  ))}
                  {summary.moreCollisions > 0 ? (
                    <span className={styles.noticeLine}>
                      {t('jobForm.startMoreCollisions', { count: summary.moreCollisions })}
                    </span>
                  ) : null}
                </span>
              </>
            )}
          </>
        )}
      </InlineBanner>
    </div>
  );
}

/** Which confirmation a chosen day needs, from its weekday alone. */
function confirmKindOf(date: string): 'buffer' | 'weekend' | null {
  if (isWeekend(date)) return 'weekend';
  return weekdayOf(date) === FRIDAY ? 'buffer' : null;
}

function blankJob(hours: number, color: string): JobFormValues {
  return { name: '', description: '', hours, color };
}
