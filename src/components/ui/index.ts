/**
 * The shared UI primitives. One import site for every screen:
 *
 *     import { Button, Field, Input, SidePanel } from '@/src/components/ui';
 *
 * Everything here is a client component styled with CSS Modules against the brand
 * tokens. None of them hardcodes a colour, and none of them hardcodes a visible
 * string — the few intrinsic labels they need (close, retry, +/-) are read from
 * public/locales through `useTranslation`, and every piece of content is a prop.
 */

export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from './Button';
export {
  IconButton,
  type IconButtonProps,
  type IconButtonSize,
  type IconButtonVariant,
} from './IconButton';
export {
  Checkbox,
  Field,
  Input,
  NumberStepper,
  Select,
  Textarea,
  type CheckboxProps,
  type FieldProps,
  type InputProps,
  type NumberStepperProps,
  type SelectOption,
  type SelectOptionGroup,
  type SelectProps,
  type TextareaProps,
} from './Field';
export { TimeSelect, type TimeSelectProps } from './TimeSelect';
export {
  TIME_STEP_MINUTES,
  clockMinutes,
  timeOptionMinutes,
  type TimeOptionsRange,
} from './timeOptions';
export { DateSelect, type DateSelectProps } from './DateSelect';
export {
  PICKER_FUTURE_WEEKS,
  PICKER_MAX_FUTURE_WEEKS,
  PICKER_PAST_WEEKS,
  dayOptionDates,
  groupDaysByWeek,
  planningWindow,
  type DayOptionWeek,
  type DayWindow,
} from './dateOptions';
export { ColorSwatches, type ColorSwatchesProps } from './ColorSwatches';
export { ColorDot, SidePanel, type SidePanelProps } from './SidePanel';
export { ConfirmDialog, type ConfirmDialogProps } from './ConfirmDialog';
export { InlineBanner, type BannerTone, type InlineBannerProps } from './InlineBanner';
export {
  ToastProvider,
  useToast,
  type ToastApi,
  type ToastInput,
  type ToastItem,
} from './Toast';
export { LanguageSwitcher, type LanguageSwitcherProps } from './LanguageSwitcher';
export { Logo, type LogoProps } from './Logo';
export { useMounted } from './useMounted';
