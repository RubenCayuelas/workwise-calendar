'use client';

/** Controlled, shared by the job panel and the create form. Hours here are DECIMAL hours. */

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
  /**
   * Overrides the stepper's half-hour grid AND its floor. A PAINTED band can be any quarter, and
   * `NumberStepper` snaps to the step before it clamps — so on the half-hour grid a 2 h 15 band was
   * rounded to 2.5 h by a focus and a blur, silently lengthening what the owner drew.
   */
  hoursStep?: number;
  /** Focuses the name field. The panel shell already focuses the first control. */
  autoFocusName?: boolean;
}

export function JobFields({
  values,
  onChange,
  errors = {},
  disabled = false,
  hoursHint,
  hoursStep,
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
          min={hoursStep ?? MIN_JOB_HOURS}
          max={MAX_JOB_HOURS}
          {...(hoursStep === undefined ? {} : { step: hoursStep })}
          suffix={t('units.hoursSuffix')}
          disabled={disabled}
          onChange={(hours) => patch({ hours })}
        />
      </Field>

      {/*
        Full-width row, not beside the stepper as in the wireframe: that was drawn with
        FIVE swatches, and the real eight 20px chips plus a stepper wrap into a ragged
        6 + 2 across a 360px panel. A radiogroup cannot carry the `Field`'s generated id,
        so `ColorSwatches` repeats the label for assistive tech.
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
 * Which field an API failure points at, merged with the form's own checks. `local` carries
 * i18n KEYS, not sentences, so messages re-translate on a mid-form language switch;
 * `message` is the caller's `apiErrorMessage(error, t, language)`.
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
