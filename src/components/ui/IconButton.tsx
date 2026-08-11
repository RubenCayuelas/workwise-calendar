'use client';

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import styles from './IconButton.module.css';

export type IconButtonVariant = 'default' | 'ghost' | 'danger';
export type IconButtonSize = 'sm' | 'md';

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label' | 'title'> {
  icon: ReactNode;
  /**
   * The accessible name AND the tooltip. Required, and it must come from i18n — an
   * icon-only control with no name is unusable, and this app has three of them per
   * block (lock, split, delete).
   */
  label: string;
  /** `sm` (24px) is the block's hover action bar; `md` (28px) the header. */
  size?: IconButtonSize;
  variant?: IconButtonVariant;
  /** A toggle that is currently on — a locked block's padlock. */
  active?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, size = 'md', variant = 'default', active = false, className, type, ...rest },
  ref,
) {
  const classes = [
    styles.iconButton,
    styles[size],
    variant === 'default' ? '' : styles[variant],
    active ? styles.active : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={classes}
      aria-label={label}
      title={label}
      {...rest}
    >
      <span className={styles.glyph} aria-hidden="true">
        {icon}
      </span>
    </button>
  );
});
