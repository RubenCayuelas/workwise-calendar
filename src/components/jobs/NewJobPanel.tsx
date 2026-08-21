'use client';

/**
 * `+ Nuevo trabajo`: the job panel's four fields plus an OPTIONAL START DATE, whose placement
 * is previewed before saving.
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
import { hoursToMinutes, isValidDate, todayLocal } from '../../lib/dates';
import { MIN_ROW_MINUTES } from '../../lib/validation';
import { PROJECT_COLORS } from '../../lib/projectColors';
import { useFormat, type Formatter } from '../../lib/useFormat';
import { JobFields, jobFieldErrors, type JobFieldName, type JobFormValues } from './JobFields';
import { PlacementNotice } from './PlacementNotice';
import { describePlacement, type PlacementOutcome } from './placement';
import {
  confirmKindFor,
  summarizeStartDate,
  type DayConfirmKind,
  type StartDateNote,
  type StartDateSummary,
} from './startDate';
import { scheduleSummaryMessage } from './summary';
import type { GridDraft } from '../calendar/draftBand';
import type { JobsMutationHandler } from './events';
import styles from './jobs.module.css';

const DEFAULT_HOURS = 8;

/** The hours stepper fires on every click, and a preview per click is a request per click. */
const PREVIEW_DELAY_MS = 220;

export interface NewJobPanelProps {
  open: boolean;
  onClose: () => void;
  /** Fired on success. The parent MUST refetch the week. */
  onChanged?: JobsMutationHandler;
  /**
   * The job that was created. The panel stays OPEN afterwards, showing where the hours
   * landed, so a parent wanting to open the job panel next must wait for `onClose` — two
   * panels share the same slot on the right.
   */
  onCreated?: (project: Project) => void;
  /** `WeekView.summary`: where the queue ends, and so where this job starts. */
  summary?: ScheduleSummary;
  /** `WeekView.today`, so "a later week" means later than the week on screen. */
  today?: string;
  defaultHours?: number;
  /** Pre-selects a swatch — e.g. the colour the calendar sees least of. */
  defaultColor?: string;
  /**
   * A BAND painted on the grid. The day and the minute are the owner's and are not editable away
   * from being a point: the hours field still wins on LENGTH, and whatever the day cannot hold
   * carries on from the next day the engine uses.
   */
  painted?: { date: string; startMinutes: number };
  /** Only with `painted`: keeps the band drawn on the grid, following these fields. */
  onDraft?: (draft: GridDraft | null) => void;
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
  painted,
  onDraft,
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
   * A fresh form on the panel's OPENING EDGE ONLY, never on a change of the defaults:
   * `defaultColor` is the swatch the calendar shows least of, so creating a job changes it
   * and the parent's refetch would wipe the notice the owner had just earned.
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
    // A painted band arrives with its day already chosen, so the date section opens ON it.
    setDated(painted !== undefined);
    setStartDate(painted?.date ?? reference);
    setForce(false);
    setPreview(null);
    setPreviewError(null);
  }, [open, defaultHours, defaultColor, reference, painted]);

  const previewable = open && !done && dated && isValidDate(startDate) && values.hours > 0;

  /**
   * The painted minute, but only while the date is still the day it was painted on. Changing the day
   * by hand gives up the point and goes back to a floor — which is the honest reading, since the
   * minute was drawn on a column that is no longer the one being asked about.
   */
  const paintedMinutes =
    painted !== undefined && startDate === painted.date ? painted.startMinutes : undefined;

  // The grid cannot know what this form holds, so the form tells it — on every change, and `null`
  // once the job is created, where the real rows take the band's place.
  useEffect(() => {
    if (onDraft === undefined) return;
    if (paintedMinutes === undefined || done) {
      onDraft(null);
      return;
    }
    onDraft({
      kind: 'job',
      date: startDate,
      startMinutes: paintedMinutes,
      durationMinutes: hoursToMinutes(values.hours),
    });
  }, [onDraft, paintedMinutes, startDate, values.hours, done]);

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
        {
          startDate,
          totalMinutes: hoursToMinutes(values.hours),
          force,
          // Only while the date is STILL the painted one: moving the day makes it an ordinary floor
          // again, and previewing a minute on another day would promise a placement nobody asked for.
          ...(paintedMinutes === undefined ? {} : { startMinutes: paintedMinutes }),
        },
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
  }, [previewable, startDate, values.hours, force, paintedMinutes]);

  const startSummary: StartDateSummary | null =
    preview === null ? null : summarizeStartDate(preview);

  const dayConfirmKind =
    !dated || !isValidDate(startDate)
      ? null
      : confirmKindFor(startDate, startSummary?.confirmKind ?? null);

  // A dated save WAITS for its preview. The weekday answers for a Friday and a weekend on its own,
  // but a closed day is invisible to it, so saving before the server has spoken could honour one
  // without ever asking. A preview that fails leaves this true and `previewMessage` says why.
  const awaitingPreview = previewable && startSummary === null;

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
        ...(paintedMinutes === undefined ? {} : { startMinutes: paintedMinutes }),
      });

      // Every row is new, so the diff against nothing is where the engine put it.
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
                disabled={saving || awaitingPreview}
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
            {/* The marks the date left on the rows: a padlock nobody asked for is explained
                where it was decided, not only as a glyph on a calendar off to the side. */}
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
          {...(painted === undefined ? {} : { hoursStep: MIN_ROW_MINUTES / 60 })}
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
                {/* Never a native date input. The window reaches
                    back on purpose: a past date records work done but never logged. */}
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
        title={t(CONFIRM_TITLE[dayConfirmKind ?? 'buffer'])}
        description={
          isValidDate(startDate)
            ? t(CONFIRM_BODY[dayConfirmKind ?? 'buffer'], { date: format.longDate(startDate) })
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
 * The rows the job would be born as, then the notes, then what is in the way. All of the
 * deciding happened in `summarizeStartDate`; this only spells it. The notes are KINDS rather
 * than strings, so this switch is the single place a start-date sentence is chosen.
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
      case 'painted':
        return t('jobForm.startPainted');
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

/** A `Record`, so a new kind of confirmation cannot be added without words for it. */
const CONFIRM_TITLE: Record<DayConfirmKind, string> = {
  buffer: 'jobForm.confirmBufferTitle',
  weekend: 'jobForm.confirmWeekendTitle',
  closed: 'jobForm.confirmClosedTitle',
};

const CONFIRM_BODY: Record<DayConfirmKind, string> = {
  buffer: 'jobForm.confirmBufferBody',
  weekend: 'jobForm.confirmWeekendBody',
  closed: 'jobForm.confirmClosedBody',
};

function blankJob(hours: number, color: string): JobFormValues {
  return { name: '', description: '', hours, color };
}
