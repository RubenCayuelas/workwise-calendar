'use client';

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * `secondary` (default) is the wireframe's white-with-a-hairline button, and what
   * most actions are. `primary` is the amber fill — one per screen at most.
   */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** A Tabler icon, drawn before the label. */
  icon?: ReactNode;
  /** Fills the width of its container, for a panel footer. */
  block?: boolean;
}

/**
 * The app's button. `type` defaults to `button`, not `submit`, because most of these
 * sit inside forms in the job panel and an accidental submit is a silent bug.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, block = false, className, children, type, ...rest },
  ref,
) {
  const classes = [styles.button, styles[variant], size === 'sm' ? styles.sm : '', block ? styles.block : '', className]
    .filter(Boolean)
    .join(' ');

  return (
    <button ref={ref} type={type ?? 'button'} className={classes} {...rest}>
      {icon === undefined ? null : (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      )}
      {children === undefined ? null : <span className={styles.label}>{children}</span>}
    </button>
  );
});
