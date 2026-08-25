'use client';

/**
 * The public holidays block of the Settings screen. The switch and the municipality belong to the
 * parent's draft and its Save button; the state line and the "check now" button act on their own,
 * because a check is not a preference.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Checkbox, Field, InlineBanner, Select } from '../ui';
import {
  apiErrorMessage,
  getHolidayState,
  isAbortError,
  runHolidayCheck,
  type HolidayState,
} from '../../lib/api-client';
import { instantToLocalDate } from '../../lib/dates';
import { useFormat } from '../../lib/useFormat';
import {
  ANDALUSIAN_MUNICIPALITIES,
  ANDALUSIAN_PROVINCES,
} from '../../lib/holidays/municipalities';
import type { Settings } from '../../types';
import styles from './SettingsScreen.module.css';

interface HolidaysSectionProps {
  draft: Settings;
  patchDraft: (patch: Partial<Settings>) => void;
  errorFor: (field: keyof Settings) => string | undefined;
}

/** Built once: 785 entries, sorted the way a Spanish reader expects to find a town. */
const MUNICIPALITY_OPTIONS = ANDALUSIAN_MUNICIPALITIES.map((municipality) => ({
  value: municipality.ine,
  label: `${municipality.name} (${ANDALUSIAN_PROVINCES[municipality.provinceIne] ?? ''})`,
})).sort((a, b) => a.label.localeCompare(b.label, 'es'));

export function HolidaysSection({
  draft,
  patchDraft,
  errorFor,
}: HolidaysSectionProps): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();

  const [state, setState] = useState<HolidayState | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [outcome, setOutcome] = useState<string | undefined>(undefined);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      setState(await getHolidayState({ signal }));
    } catch (error) {
      if (!isAbortError(error)) setFailure(error);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const checkNow = useCallback(async () => {
    setBusy(true);
    setFailure(undefined);
    setOutcome(undefined);
    try {
      const result = await runHolidayCheck(true);
      setState(result.state);
      setOutcome(
        result.closed.length === 0
          ? t('settings.holidaysCheckedNothing')
          : t('settings.holidaysCheckedClosed', { count: result.closed.length }),
      );
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }, [t]);

  return (
    <section className={`ww-card ${styles.section}`}>
      <h2 className={styles.sectionTitle}>{t('settings.holidaysSection')}</h2>
      <p className={styles.sectionHint}>{t('settings.holidaysHint')}</p>

      <div className={styles.rows}>
        <div className={styles.row}>
          <Checkbox
            label={t('settings.holidaysEnabled')}
            hint={t('settings.holidaysEnabledHint')}
            checked={draft.holidaysEnabled}
            onChange={(event) => patchDraft({ holidaysEnabled: event.target.checked })}
          />
        </div>

        <Field
          label={t('settings.holidaysMunicipality')}
          inline
          hint={t('settings.holidaysMunicipalityHint')}
          error={errorFor('holidaysMunicipality')}
        >
          <Select
            options={MUNICIPALITY_OPTIONS}
            value={draft.holidaysMunicipality}
            onChange={(event) => patchDraft({ holidaysMunicipality: event.target.value })}
            disabled={!draft.holidaysEnabled}
          />
        </Field>

        <div className={styles.row}>
          <p className={styles.note}>
            {state === undefined || state.count === 0
              ? t('settings.holidaysLoadedNone')
              : t('settings.holidaysLoaded', {
                  count: state.count,
                  through: format.mediumDate(state.knownThrough ?? ''),
                })}
          </p>
          {state?.lastCheckedAt === null || state?.lastCheckedAt === undefined ? null : (
            <p className={styles.note}>
              {t(
                state.lastCheckSucceeded ? 'settings.holidaysCheckedAt' : 'settings.holidaysCheckFailed',
                { date: format.mediumDate(instantToLocalDate(new Date(state.lastCheckedAt))) },
              )}
            </p>
          )}
          <div className={styles.backupActions}>
            <Button variant="secondary" onClick={() => void checkNow()} disabled={busy}>
              {t('settings.holidaysCheckNow')}
            </Button>
          </div>
          {outcome === undefined ? null : <p className={styles.note}>{outcome}</p>}
          {failure === undefined ? null : (
            <InlineBanner tone="error">{apiErrorMessage(failure, t)}</InlineBanner>
          )}
        </div>

        <p className={`${styles.note} ww-small ww-muted`}>{t('settings.holidaysAttribution')}</p>
      </div>
    </section>
  );
}
