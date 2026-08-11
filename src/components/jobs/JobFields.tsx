'use client';

/**
 * The four fields a job has, in the wireframe's order: Nombre, Descripción, then
 * Horas totales beside Color.
 *
 * Shared by the job panel and the create form so a job is described the same way
 * whether it is being made or edited. It owns no request and no scheduling opinion —
 * it is a controlled form.
 *
 * Two constraints from CLAUDE.md are structural here:
 * - `Color` is the fixed swatch set (`ColorSwatches`), never a free hex input.
 * - Hours are DECIMAL HOURS in this form, because that is what the owner types; the
 *   panels convert with `hoursToMinutes` at the request boundary.
 */

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ColorSwatches, Field, Input, NumberStepper, Textarea } from '../ui';
import { isApiError } from '../../lib/api-client';
import styles from './jobs.module.css';

/** Half an hour: the smallest amount the shop plans in, and the API's own granularity. */
export const MIN_JOB_HOURS = 0.5;
/** `MAX_TOTAL_HOURS` in src/lib/api.ts. Beyond it the request is a 400. */
export const MAX_JOB_HOURS = 9999;

export interface JobFormValues {
  name: string;
  /** Empty string means "no description"; the panel sends `null` to clear a stored one. */
  description: string;
  /** Decimal hours. */
  hours: number;
  /** A hex from `PROJECT_COLORS`. */
  color: string;
}

export type JobFieldName = 'name' | 'description' | 'hours' | 'color';

export type JobFieldErrors = Partial<Record<JobFieldName, string>>;

export interface JobFieldsProps {
  values: JobFormValues;
  onChange: (values: JobFormValues) => void;
  /** Already translated, e.g. from `jobFieldErrors`. */
  errors?: JobFieldErrors;
  disabled?: boolean;
  /**
   * Replaces `jobPanel.totalHoursHint`. Pass `null` for no hint at all — the create
   * form has no last block to add hours to, so the LIFO explanation would be a lie.
   */
  hoursHint?: ReactNode | null;
  /** Focuses the name field. The panel shell already focuses the first control. */
  autoFocusName?: boolean;
}

export function JobFields({
  values,
  onChange,
  errors = {},
  disabled = false,
  hoursHint,
  autoFocusName = false,
}: JobFieldsProps): React.JSX.Element {
  const { t } = useTranslation();

  const patch = (next: Partial<JobFormValues>): void => onChange({ ...values, ...next });

  // `undefined` means "use the default", `null` means "no hint" — hence no `??`.
  const resolvedHoursHint = hoursHint === undefined ? t('jobPanel.totalHoursHint') : hoursHint;

  return (
    <>
      <Field label={t('jobPanel.name')} required error={errors.name}>
        <Input
          value={values.name}
          placeholder={t('jobPanel.namePlaceholder')}
          disabled={disabled}
          autoFocus={autoFocusName}
          onChange={(event) => patch({ name: event.target.value })}
        />
      </Field>

      <Field label={t('jobPanel.description')} optional error={errors.description}>
        <Textarea
          value={values.description}
          placeholder={t('jobPanel.descriptionPlaceholder')}
          rows={2}
          disabled={disabled}
          onChange={(event) => patch({ description: event.target.value })}
        />
      </Field>

      <Field
        label={t('jobPanel.totalHours')}
        hint={resolvedHoursHint ?? undefined}
        error={errors.hours}
      >
        <NumberStepper
          value={values.hours}
          min={MIN_JOB_HOURS}
          max={MAX_JOB_HOURS}
          suffix={t('units.hoursSuffix')}
          disabled={disabled}
          onChange={(hours) => patch({ hours })}
        />
      </Field>

      {/*
        `Horas totales` and `Color` sit side by side in the wireframe, which was drawn
        with FIVE swatches. The real palette has eight (`--ww-project-1..8`), and eight
        20px chips plus a stepper do not fit across a 360px panel — they would wrap into
        a ragged 6 + 2. So the colour row gets the full width and the palette stays one
        line, which is how a palette is meant to be read.

        The swatches are a radiogroup, so they cannot carry the `Field`'s generated id
        the way an input does; `ColorSwatches` names itself with the same label for
        assistive tech, which is why the visible label and the group label match.
      */}
      <Field label={t('jobPanel.color')} error={errors.color}>
        <div className={styles.swatchRow}>
          <ColorSwatches
            value={values.color}
            label={t('jobPanel.color')}
            disabled={disabled}
            onChange={(color) => patch({ color })}
          />
        </div>
      </Field>
    </>
  );
}

/**
 * Which field an API failure points at, merged with the form's own checks.
 *
 * `local` carries i18n KEYS rather than sentences so the messages re-translate when
 * the owner switches language mid-form; `error` is whatever the last request threw,
 * and `message` is `apiErrorMessage(error, t, language)` computed once by the caller.
 */
export function jobFieldErrors(
  local: Partial<Record<JobFieldName, string>>,
  error: unknown,
  t: (key: string) => string,
  message?: string,
): JobFieldErrors {
  const errors: JobFieldErrors = {};
  for (const field of ['name', 'description', 'hours', 'color'] as const) {
    const key = local[field];
    if (key !== undefined) errors[field] = t(key);
  }

  if (isApiError(error) && error.field !== undefined && message !== undefined) {
    const field = FIELD_OF_API_FIELD[error.field];
    if (field !== undefined && errors[field] === undefined) errors[field] = message;
  }

  return errors;
}

/** The payload keys the API validates, mapped onto this form's controls. */
const FIELD_OF_API_FIELD: Record<string, JobFieldName | undefined> = {
  name: 'name',
  description: 'description',
  color: 'color',
  totalMinutes: 'hours',
  totalHours: 'hours',
};
