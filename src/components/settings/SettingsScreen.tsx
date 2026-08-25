'use client';

/**
 * The Settings screen. The draft is never rewritten to pose a question, which is what lets
 * Cancel leave the rest of the unsaved form untouched; the language is not part of `Settings`.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { IconDeviceFloppy } from '@tabler/icons-react';
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Field,
  InlineBanner,
  NumberStepper,
  Select,
  TimeSelect,
  useToast,
} from '../ui';
import { useLanguage } from '../I18nProvider';
import {
  apiErrorMessage,
  getSettings,
  isAbortError,
  isApiError,
  updateSettings,
} from '../../lib/api-client';
import { hoursToMinutes } from '../../lib/dates';
import { useFormat } from '../../lib/useFormat';
import type { Settings } from '../../types';
import { BackupsSection } from './BackupsSection';
import { HolidaysSection } from './HolidaysSection';
import { DayTimelinePreview } from './DayTimelinePreview';
import { loadScheduledBlocks } from './scheduleData';
import {
  HORIZON_MAX_WEEKS,
  HORIZON_MIN_WEEKS,
  HOUR_STEP,
  MARGIN_MAX_HOURS,
  MARGIN_MIN_HOURS,
  applySettingsPatch,
  capacityReductionOf,
  capacitySlackMinutes,
  draftIssues,
  hasIssues,
  maxCapacityHours,
  minCapacityHours,
  patchToSave,
  shiftMinutesOf,
  timelineOf,
  type CapacityReduction,
} from './shift';
import {
  assessRisk,
  findAffectedBlocks,
  needsBlockCheck,
  type AffectedBlock,
  type ChangeRisk,
} from './warnings';
import styles from './SettingsScreen.module.css';

/** The id the gap colour input and its label share: a native colour input cannot pick
 *  the generated one up from `Field`'s context the way `Input` does. */
const GAP_COLOR_ID = 'ww-settings-gap-color';

interface PendingSave {
  patch: Partial<Settings>;
  affected: AffectedBlock[];
  risk: ChangeRisk;
  /** Set when saving would have to lower the capacity: the question, with both numbers. */
  reduction?: CapacityReduction;
}

export function SettingsScreen(): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const toast = useToast();
  const { language, languages, setLanguage } = useLanguage();

  const [saved, setSaved] = useState<Settings | undefined>(undefined);
  const [draft, setDraft] = useState<Settings | undefined>(undefined);
  // Raw throwables, not messages: translating during render means a language switch
  // re-words an error already on screen.
  const [loadError, setLoadError] = useState<unknown>(undefined);
  const [saveError, setSaveError] = useState<unknown>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [pending, setPending] = useState<PendingSave | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    setLoadError(undefined);

    getSettings({ signal: controller.signal })
      .then((view) => {
        setSaved(view.settings);
        setDraft(view.settings);
      })
      .catch((error: unknown) => {
        if (!isAbortError(error)) setLoadError(error);
      });

    return () => controller.abort();
  }, [attempt]);

  const patchDraft = useCallback(
    (patch: Partial<Settings>): void => {
      if (draft === undefined) return;
      // A merge and nothing else: the capacity is not pulled down to fit a shorter shift
      // here, on save, or anywhere between.
      setDraft(applySettingsPatch(draft, patch));
      // A stale field error would keep pointing at an input the owner has just fixed.
      setSaveError(undefined);
    },
    [draft],
  );

  const issues = useMemo(() => (draft === undefined ? {} : draftIssues(draft)), [draft]);
  /** The capacity the draft can no longer afford, if any: what the confirmation is about. */
  const reduction = useMemo(
    () => (draft === undefined ? undefined : capacityReductionOf(draft)),
    [draft],
  );
  // The changed fields PLUS that lowered capacity, so one request carries the whole
  // decision. Lowering the capacity IS a change to save, so `dirty` reads the same patch.
  const patch = useMemo(
    () => (saved === undefined || draft === undefined ? {} : patchToSave(saved, draft)),
    [saved, draft],
  );
  const dirty = Object.keys(patch).length > 0;

  const commit = useCallback(
    async (fields: Partial<Settings>): Promise<void> => {
      if (draft === undefined) return;
      setSaving(true);
      setSaveError(undefined);

      try {
        const result = await updateSettings(fields);
        setSaved(result.settings);
        // The server's values, not the form's: the write path no longer adjusts anything
        // silently, so the two agree — but the server stays the source.
        setDraft(result.settings);
        setPending(undefined);
        toast.success(t('settings.saved'));
      } catch (error) {
        if (!isAbortError(error)) setSaveError(error);
        // Close the confirmation on failure too, or the message lands behind its own scrim.
        setPending(undefined);
      } finally {
        setSaving(false);
      }
    },
    [draft, t, toast],
  );

  const requestSave = useCallback(async (): Promise<void> => {
    if (saved === undefined || draft === undefined || !dirty || hasIssues(issues)) return;

    const risk = assessRisk(saved, draft);
    let affected: AffectedBlock[] = [];

    if (needsBlockCheck(risk)) {
      setChecking(true);
      try {
        affected = findAffectedBlocks(saved, draft, await loadScheduledBlocks());
      } catch (error) {
        // The check itself failed; saving anyway would be a silent discard.
        if (!isAbortError(error)) {
          setSaveError(error);
          return;
        }
      } finally {
        setChecking(false);
      }
    }

    // Either question goes through the same dialog, and a change can raise both at once:
    // one confirmation states everything the save will do.
    if (affected.length > 0 || reduction !== undefined) {
      setPending({ patch, affected, risk, reduction });
      return;
    }

    await commit(patch);
  }, [saved, draft, dirty, issues, patch, reduction, commit]);

  // ---- loading and hard failures -----------------------------------------

  if (draft === undefined) {
    return (
      <div className="ww-page ww-page--narrow">
        {loadError === undefined ? (
          <p className="ww-muted">{t('common.loading')}</p>
        ) : (
          <InlineBanner
            tone="error"
            title={t('errors.title')}
            onRetry={() => setAttempt((value) => value + 1)}
          >
            {apiErrorMessage(loadError, t, language)}
          </InlineBanner>
        )}
      </div>
    );
  }

  // ---- derived, live, from the draft --------------------------------------

  const shiftMinutes = shiftMinutesOf(draft);
  const shiftHours = maxCapacityHours(draft);
  const slackMinutes = capacitySlackMinutes(draft);
  const timeline = timelineOf(draft);
  const failedField = isApiError(saveError) ? saveError.field : undefined;

  /**
   * The message under a control. Local problems and the server's rejection share one
   * wording: `errors.settingsInvalid` is the only key the data layer emits for a bad setting.
   */
  const errorFor = (field: keyof Settings): string | undefined => {
    if (issues[field] !== undefined) return t('errors.settingsInvalid');
    if (failedField === field) return apiErrorMessage(saveError, t, language);
    return undefined;
  };

  const blockLabel = (entry: AffectedBlock): string =>
    t('block.label', {
      name: entry.projectName,
      day: format.dayHeader(entry.block.date),
      start: format.time(entry.block.startMinutes),
      end: format.time(entry.block.startMinutes + entry.block.durationMinutes),
      hours: format.hourNumber(entry.block.durationMinutes),
    });

  return (
    <div className={`ww-page ww-page--narrow ${styles.page}`}>
      <header className={styles.head}>
        <h1 className={styles.title}>{t('settings.title')}</h1>
        <p className="ww-muted">{t('settings.subtitle')}</p>
      </header>

      {/* ---- the shift ---- */}
      <Section title={t('settings.shiftSection')} hint={t('settings.shiftHint')}>
        <TimeRow
          label={t('settings.period1Start')}
          value={draft.period1Start}
          error={errorFor('period1Start')}
          onChange={(value) => patchDraft({ period1Start: value })}
        />

        <TimeRow
          label={t('settings.period1End')}
          value={draft.period1End}
          error={errorFor('period1End')}
          onChange={(value) => patchDraft({ period1End: value })}
        />

        <div className={styles.row}>
          <Checkbox
            label={t('settings.period2Enabled')}
            hint={t('settings.period2EnabledHint')}
            checked={draft.period2Enabled}
            onChange={(event) => patchDraft({ period2Enabled: event.target.checked })}
          />
        </div>

        <TimeRow
          label={t('settings.period2Start')}
          value={draft.period2Start}
          disabled={!draft.period2Enabled}
          error={draft.period2Enabled ? errorFor('period2Start') : undefined}
          onChange={(value) => patchDraft({ period2Start: value })}
        />

        <TimeRow
          label={t('settings.period2End')}
          value={draft.period2End}
          disabled={!draft.period2Enabled}
          error={draft.period2Enabled ? errorFor('period2End') : undefined}
          onChange={(value) => patchDraft({ period2End: value })}
        />

        <p className={styles.note}>
          {t('settings.shiftTotal', { hours: format.hourNumber(shiftMinutes) })}
        </p>
      </Section>

      {/* ---- the auto-fill stop line ---- */}
      <Section title={t('settings.capacitySection')}>
        <Field
          label={t('settings.defaultDayCapacity')}
          inline
          hint={t('settings.defaultDayCapacityHint', {
            max: format.hourNumber(hoursToMinutes(shiftHours)),
          })}
          error={errorFor('defaultDayCapacity')}
        >
          <NumberStepper
            value={draft.defaultDayCapacity}
            onChange={(value) => patchDraft({ defaultDayCapacity: value })}
            min={shiftHours > 0 ? minCapacityHours(draft) : undefined}
            // The shift is the ceiling EXCEPT while the draft already sits above it: the
            // stepper clamps on blur, so a lower max would have the field itself lower the
            // number the owner is about to be asked about.
            max={shiftHours > 0 ? Math.max(shiftHours, draft.defaultDayCapacity) : undefined}
            step={HOUR_STEP}
            suffix={t('units.hoursSuffix')}
            disabled={shiftHours <= 0}
          />
        </Field>

        {/* Two quiet facts, never a warning: choosing to fill six hours of a ten hour day
            is legitimate, it is just invisible on the grid unless it is said here. */}
        {reduction !== undefined ? (
          <p className={styles.note}>
            {t('settings.capacityWillLower', {
              from: format.hourNumber(hoursToMinutes(reduction.fromHours)),
              to: format.hourNumber(hoursToMinutes(reduction.toHours)),
            })}
          </p>
        ) : slackMinutes > 0 ? (
          <p className={styles.note}>
            {t('settings.capacityBelowShift', {
              capacity: format.hourNumber(hoursToMinutes(draft.defaultDayCapacity)),
              shift: format.hourNumber(shiftMinutes),
              free: format.hourNumber(slackMinutes),
            })}
          </p>
        ) : null}
      </Section>

      {/* ---- visual margins ---- */}
      <Section
        title={t('settings.marginsSection')}
        hint={t('settings.marginsHint', { min: MARGIN_MIN_HOURS, max: MARGIN_MAX_HOURS })}
      >
        <Field label={t('settings.visualMarginTop')} inline error={errorFor('visualMarginTop')}>
          <NumberStepper
            value={draft.visualMarginTop}
            onChange={(value) => patchDraft({ visualMarginTop: value })}
            min={MARGIN_MIN_HOURS}
            max={MARGIN_MAX_HOURS}
            step={HOUR_STEP}
            suffix={t('units.hoursSuffix')}
          />
        </Field>

        <Field label={t('settings.visualMarginBottom')} inline error={errorFor('visualMarginBottom')}>
          <NumberStepper
            value={draft.visualMarginBottom}
            onChange={(value) => patchDraft({ visualMarginBottom: value })}
            min={MARGIN_MIN_HOURS}
            max={MARGIN_MAX_HOURS}
            step={HOUR_STEP}
            suffix={t('units.hoursSuffix')}
          />
        </Field>
      </Section>

      {/* ---- what those numbers actually draw ---- */}
      <Section title={t('grid.timeAxis')}>
        {timeline === undefined ? (
          <InlineBanner tone="warning">{t('errors.settingsInvalid')}</InlineBanner>
        ) : (
          <DayTimelinePreview settings={draft} />
        )}
      </Section>

      {/* ---- planning horizon ---- */}
      <Section title={t('settings.planningSection')}>
        <Field
          label={t('settings.planningHorizonWeeks')}
          inline
          hint={t('settings.planningHorizonWeeksHint', {
            min: HORIZON_MIN_WEEKS,
            max: HORIZON_MAX_WEEKS,
          })}
          error={errorFor('planningHorizonWeeks')}
        >
          <NumberStepper
            value={draft.planningHorizonWeeks}
            onChange={(value) => patchDraft({ planningHorizonWeeks: value })}
            min={HORIZON_MIN_WEEKS}
            max={HORIZON_MAX_WEEKS}
            step={1}
          />
        </Field>

        <p className={styles.note}>{t('settings.planningHorizonWarning')}</p>
      </Section>

      {/* ---- appearance ---- */}
      <Section title={t('settings.appearanceSection')}>
        <Field
          label={t('settings.gapColor')}
          inline
          id={GAP_COLOR_ID}
          hint={t('settings.gapColorHint')}
          error={errorFor('gapColor')}
        >
          <span className={styles.colorControl}>
            <input
              id={GAP_COLOR_ID}
              className={styles.colorInput}
              type="color"
              value={draft.gapColor}
              // Uppercased on the way in because that is how the server stores it; a
              // lower-case echo of the same colour would otherwise read as a change.
              onChange={(event) => patchDraft({ gapColor: event.target.value.toUpperCase() })}
            />
            <span className="ww-small ww-muted ww-tabular">{draft.gapColor}</span>
          </span>
        </Field>
      </Section>

      {/* ---- backups: the preferences save with the rest, the buttons act on their own ---- */}
      <BackupsSection draft={draft} patchDraft={patchDraft} errorFor={errorFor} />

      <HolidaysSection draft={draft} patchDraft={patchDraft} errorFor={errorFor} />

      {/* ---- language: applied immediately, outside the Save button ---- */}
      <Section title={t('settings.languageSection')}>
        <Field label={t('settings.language')} inline hint={t('settings.languageHint')}>
          <Select
            className={styles.selectControl}
            value={language}
            options={languages.map((code) => ({ value: code, label: t(`languages.${code}`) }))}
            onChange={(event) => {
              const next = languages.find((code) => code === event.target.value);
              if (next !== undefined) setLanguage(next);
            }}
          />
        </Field>
      </Section>

      {/* The refusal belongs next to the button that caused it: this page is taller than the
          window, so a banner at the top would land off screen. Also marked on its control. */}
      {saveError === undefined ? null : (
        <InlineBanner tone="error" title={t('errors.title')} onDismiss={() => setSaveError(undefined)}>
          {apiErrorMessage(saveError, t, language)}
        </InlineBanner>
      )}

      <div className={styles.actions}>
        {dirty ? <span className="ww-small ww-muted">{t('jobPanel.unsavedChanges')}</span> : null}
        <span className="ww-spacer" />
        <Button
          variant="primary"
          icon={<IconDeviceFloppy size={15} stroke={1.75} />}
          disabled={!dirty || hasIssues(issues) || saving || checking}
          onClick={() => void requestSave()}
        >
          {saving || checking ? t('common.saving') : t('settings.save')}
        </Button>
      </div>

      <ConfirmDialog
        open={pending !== undefined}
        title={t('settings.save')}
        danger={false}
        busy={saving}
        busyLabel={t('common.saving')}
        confirmLabel={t('settings.save')}
        onCancel={() => setPending(undefined)}
        onConfirm={() => {
          if (pending !== undefined) void commit(pending.patch);
        }}
        description={
          pending === undefined ? undefined : (
            <>
              {/* The capacity question first: it is the one the owner did not ask for. */}
              {pending.reduction === undefined ? null : (
                <>
                  <span className={styles.warnLine}>
                    {t('settings.capacityLowerConfirm', {
                      from: format.hourNumber(hoursToMinutes(pending.reduction.fromHours)),
                      to: format.hourNumber(hoursToMinutes(pending.reduction.toHours)),
                    })}
                  </span>
                  <span className={styles.warnLine}>
                    {t('settings.capacityLowerCost', {
                      lost: format.hourNumber(hoursToMinutes(pending.reduction.lostHours)),
                    })}
                  </span>
                </>
              )}

              {pending.risk.disablesAfternoon ? (
                <span className={styles.warnLine}>{t('settings.period2EnabledHint')}</span>
              ) : null}
              {pending.risk.narrowsHorizon ? (
                <span className={styles.warnLine}>{t('settings.planningHorizonWarning')}</span>
              ) : null}

              {pending.affected.length === 0 ? null : (
                <>
                  <span className={styles.warnLine}>
                    {t('units.blocks', { count: pending.affected.length })}
                  </span>
                  {/* Every affected block, not a sample: the count above it has to match
                      what is on screen. The list scrolls inside the dialog. */}
                  <span className={styles.warnList}>
                    {pending.affected.map((entry) => (
                      <span key={entry.block.id} className={styles.warnItem}>
                        {blockLabel(entry)}
                      </span>
                    ))}
                  </span>
                </>
              )}

              <span className={styles.warnLine}>{t('notices.recomposed')}</span>
              {pending.affected.length === 0 ? null : (
                <span className={styles.warnLine}>{t('day.frozenHint')}</span>
              )}
            </>
          )
        }
      />
    </div>
  );
}

interface TimeRowProps {
  label: string;
  value: string;
  error?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}

/**
 * One period boundary, as a list of quarter hours rather than `<input type="time">`, which
 * renders in the BROWSER's locale: this form showed "08:00 AM" beside a calendar reading
 * "08:00–14:00".
 */
function TimeRow({ label, value, error, disabled = false, onChange }: TimeRowProps): React.JSX.Element {
  return (
    <Field label={label} inline error={error}>
      <TimeSelect
        className={styles.timeSelect}
        value={value}
        disabled={disabled}
        onChange={onChange}
      />
    </Field>
  );
}

interface SectionProps {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
}

/** A card of settings rows: small label above or beside each control, hairline dividers. */
function Section({ title, hint, children }: SectionProps): React.JSX.Element {
  return (
    <section className={`ww-card ${styles.section}`}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      {hint === undefined ? null : <p className={styles.sectionHint}>{hint}</p>}
      <div className={styles.rows}>{children}</div>
    </section>
  );
}
