'use client';

/**
 * The header the wireframe specifies: logo, `‹ Semana 33 · 10–16 ago 2026 ›`, then
 * `Hoy`, `+ Nuevo trabajo`, the language switch and the overflow menu.
 *
 * Paging is a GET — nothing here can trigger a recomposition — which is what makes it
 * safe to hold the arrow keys down (the screen binds them to the same two callbacks).
 *
 * `onNewJob` and `onNewGap` are optional because the forms they open live outside the
 * calendar. A control with nothing behind it is disabled rather than silently dead.
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  IconCalendarPlus,
  IconChevronLeft,
  IconChevronRight,
  IconDots,
  IconPlus,
  IconSettings,
} from '@tabler/icons-react';
import { Button, IconButton, LanguageSwitcher, Logo } from '../ui';
import styles from './WeekHeader.module.css';

export interface WeekHeaderProps {
  /** Already formatted: `useFormat().weekLabel(...)`. Empty while the week loads. */
  weekLabel: string;
  /** No week has arrived yet: the pager has nothing to page from. */
  disabled: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
  onNewJob?: () => void;
  onNewGap?: () => void;
  settingsHref: string;
}

export function WeekHeader({
  weekLabel,
  disabled,
  onPrevious,
  onNext,
  onToday,
  onNewJob,
  onNewGap,
  settingsHref,
}: WeekHeaderProps): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <header className="ww-app__header">
      <Logo />

      <span className="ww-spacer" />

      {/* No aria-label: both buttons are named, and a second landmark called "the
          workshop week" would only compete with the grid's own. */}
      <nav className={styles.pager}>
        <IconButton
          icon={<IconChevronLeft size={18} stroke={1.75} />}
          label={t('header.previousWeek')}
          disabled={disabled}
          onClick={onPrevious}
        />
        {/* Polite: the week label is the one thing that changes on every page. */}
        <span className={styles.weekLabel} aria-live="polite">
          {/*
           * KEYED ON THE LABEL, so React replaces the node on every page turn and the
           * change animation runs again. It is a separate element from the live region on
           * purpose: remounting the region itself is what makes an announcement unreliable.
           *
           * It earns its keep with the drag: holding a block at the edge of the grid pages
           * the calendar while the owner's eyes are on the BLOCK, so the one thing on
           * screen that says which week they are now in has to move to be noticed.
           */}
          <span key={weekLabel} className={styles.weekLabelText}>
            {weekLabel}
          </span>
        </span>
        <IconButton
          icon={<IconChevronRight size={18} stroke={1.75} />}
          label={t('header.nextWeek')}
          disabled={disabled}
          onClick={onNext}
        />
      </nav>

      <span className="ww-spacer" />

      <div className="ww-toolbar">
        <Button title={t('header.todayHint')} disabled={disabled} onClick={onToday}>
          {t('header.today')}
        </Button>
        <Button
          variant="primary"
          icon={<IconPlus size={15} stroke={2} />}
          title={t('header.newJobHint')}
          disabled={onNewJob === undefined}
          onClick={onNewJob}
        >
          {t('header.newJob')}
        </Button>
        <LanguageSwitcher />
        <OverflowMenu settingsHref={settingsHref} onNewGap={onNewGap} />
      </div>
    </header>
  );
}

function OverflowMenu({
  settingsHref,
  onNewGap,
}: {
  settingsHref: string;
  onNewGap?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return;
      if (wrapper.current?.contains(event.target) === true) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className={styles.menu} ref={wrapper}>
      <IconButton
        icon={<IconDots size={18} stroke={1.75} />}
        label={t('header.menu')}
        active={open}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      />

      {!open ? null : (
        <div className={styles.menuList} role="menu">
          {onNewGap === undefined ? null : (
            <button
              type="button"
              role="menuitem"
              className={styles.menuItem}
              onClick={() => {
                setOpen(false);
                onNewGap();
              }}
            >
              <span className={styles.menuGlyph} aria-hidden="true">
                <IconCalendarPlus size={16} stroke={1.75} />
              </span>
              {t('header.menuNewGap')}
            </button>
          )}

          <a role="menuitem" className={styles.menuItem} href={settingsHref}>
            <span className={styles.menuGlyph} aria-hidden="true">
              <IconSettings size={16} stroke={1.75} />
            </span>
            {t('header.menuSettings')}
          </a>
        </div>
      )}
    </div>
  );
}
