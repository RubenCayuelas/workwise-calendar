'use client';

/**
 * A time of day, chosen from a list of quarter hours.
 *
 * The Settings screen's period rows were the first place this was needed and the reason
 * it exists: a native `<input type="time">` follows the BROWSER's locale, so the same
 * form showed "08:00 AM" next to a calendar reading "08:00–14:00". The gap form and the
 * split form used the same native input and had the same bug, so all three now share
 * this one control — see `timeOptions.ts` for the arithmetic and the granularity.
 *
 * It is a `Select`, so inside a `Field` it picks up the generated id, the
 * `aria-describedby` and the invalid ring like every other control here.
 */

import { minutesToHHmm } from '../../lib/dates';
import { useFormat } from '../../lib/useFormat';
import { Select } from './Field';
import { TIME_STEP_MINUTES, clockMinutes, timeOptionMinutes } from './timeOptions';

export interface TimeSelectProps {
  /** `HH:mm`. A value that is not a time at all is kept as its own option. */
  value: string;
  onChange: (value: string) => void;
  /** Defaults to `TIME_STEP_MINUTES`, the quarter hour the grid snaps to. */
  stepMinutes?: number;
  /** Bounds, in minutes from midnight. Default to the whole day. */
  minMinutes?: number;
  maxMinutes?: number;
  disabled?: boolean;
  /** Forces the invalid ring when the control is not inside a `Field`. */
  invalid?: boolean;
  id?: string;
  className?: string;
}

export function TimeSelect({
  value,
  onChange,
  stepMinutes = TIME_STEP_MINUTES,
  minMinutes,
  maxMinutes,
  disabled = false,
  invalid,
  id,
  className,
}: TimeSelectProps): React.JSX.Element {
  const format = useFormat();

  const current = clockMinutes(value);
  const options = timeOptionMinutes(current, { stepMinutes, minMinutes, maxMinutes }).map(
    (minutes) => ({ value: minutesToHHmm(minutes), label: format.time(minutes) }),
  );
  // An unparseable stored value still has to be visible rather than silently replaced
  // by whatever the list happens to start with.
  if (current === undefined) options.unshift({ value, label: value });

  return (
    <Select
      className={className}
      value={current === undefined ? value : minutesToHHmm(current)}
      options={options}
      disabled={disabled}
      invalid={invalid}
      id={id}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
