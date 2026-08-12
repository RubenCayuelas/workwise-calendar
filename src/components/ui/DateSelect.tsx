'use client';

/**
 * A day, chosen from the days of the schedule.
 *
 * The counterpart of `TimeSelect`, and it exists for the same reason: a native
 * `<input type="date">` renders in the BROWSER's locale, so a shop PC with Chrome in
 * English shows `08/12/2026` for the 12th of August while the grid beside it reads
 * "Mié 12 ago". `03/08` is then genuinely ambiguous. Here the day is spelled by
 * `useFormat()`, exactly as the calendar spells it, and grouped under the same week
 * label the header shows — so a form and the grid can never name the same day
 * differently.
 *
 * It is a `Select`, so inside a `Field` it picks up the generated id, the
 * `aria-describedby` and the invalid ring like every other control here, and it is
 * keyboard-operable with no code of our own. See `dateOptions.ts` for which days it
 * offers and why the window is bounded.
 */

import { isValidDate } from '../../lib/dates';
import { useFormat } from '../../lib/useFormat';
import { Select, type SelectOptionGroup } from './Field';
import { dayOptionDates, groupDaysByWeek, planningWindow } from './dateOptions';

export interface DateSelectProps {
  /** Local `YYYY-MM-DD`. A value that is not a date at all is kept as its own option. */
  value: string;
  onChange: (value: string) => void;
  /** The shop's today: marks one option and anchors the default window. */
  today: string;
  /** The owner's `planningHorizonWeeks`, which is how far forward the list reaches. */
  horizonWeeks?: number;
  /** Explicit bounds, when the caller wants something other than the window above. */
  minDate?: string;
  maxDate?: string;
  disabled?: boolean;
  /** Forces the invalid ring when the control is not inside a `Field`. */
  invalid?: boolean;
  id?: string;
  className?: string;
}

export function DateSelect({
  value,
  onChange,
  today,
  horizonWeeks,
  minDate,
  maxDate,
  disabled = false,
  invalid,
  id,
  className,
}: DateSelectProps): React.JSX.Element {
  const format = useFormat();

  const window = planningWindow(isValidDate(today) ? today : value, horizonWeeks);
  const days = dayOptionDates(value, {
    minDate: minDate ?? window.minDate,
    maxDate: maxDate ?? window.maxDate,
  });

  const groups: SelectOptionGroup[] = groupDaysByWeek(days).map((week) => ({
    label: format.weekLabel(week.isoWeek, week.startDate, week.endDate),
    options: week.dates.map((date) => ({
      value: date,
      label: date === today ? format.todayOption(date) : format.dayOption(date),
    })),
  }));

  // A stored value that is not a date at all still has to be visible rather than
  // silently replaced by whatever the list happens to start with.
  const orphan = isValidDate(value) ? [] : [{ value, label: value }];

  return (
    <Select
      className={className}
      value={value}
      options={orphan}
      groups={groups}
      disabled={disabled}
      invalid={invalid}
      id={id}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
