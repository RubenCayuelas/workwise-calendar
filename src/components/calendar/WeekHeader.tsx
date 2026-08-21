'use client';

/** Paging is a GET, so holding the arrow keys down is safe. */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  IconArrowBackUp,
  IconArrowForwardUp,
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
  onNewAbsence?: () => void;
  settingsHref: string;
  /**
   * Already worded by the screen, which is the only place that knows how to name a step — and
   * which says why the control is off when it is off, rather than leaving it grey and mute.
   */
  undoLabel: string;
  redoLabel: string;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

export function WeekHeader({
  weekLabel,
  disabled,
  onPrevious,
  onNext,
  onToday,
  onNewJob,
  onNewAbsence,
  settingsHref,
  undoLabel,
  redoLabel,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: WeekHeaderProps): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <header className="ww-app__header">
      <Logo />

      <span className="ww-spacer" />

      {/* No aria-label: a second landmark would only compete with the grid's own. */}
      <nav className={styles.pager}>
        <IconButton
          icon={<IconChevronLeft size={18} stroke={1.75} />}
          label={t('header.previousWeek')}
          disabled={disabled}
          onClick={onPrevious}
        />
        {/* Polite: the week label is the one thing that changes on every page. */}
        <span className={styles.weekLabel} aria-live="polite">
          {/* Keyed on the label so React replaces the node and the change animation runs
              again. Separate from the live region: remounting that makes the announcement
              unreliable. */}
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
        {/* Ghost, so the pair sits quietly beside the controls that do something every day:
            the keyboard is the normal route to them. */}
        <IconButton
          icon={<IconArrowBackUp size={18} stroke={1.75} />}
          label={undoLabel}
          variant="ghost"
          disabled={!canUndo}
          onClick={onUndo}
        />
        <IconButton
          icon={<IconArrowForwardUp size={18} stroke={1.75} />}
          label={redoLabel}
          variant="ghost"
          disabled={!canRedo}
          onClick={onRedo}
        />
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
        <OverflowMenu settingsHref={settingsHref} onNewAbsence={onNewAbsence} />
      </div>
    </header>
  );
}

function OverflowMenu({
  settingsHref,
  onNewAbsence,
}: {
  settingsHref: string;
  onNewAbsence?: () => void;
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
          {onNewAbsence === undefined ? null : (
            <button
              type="button"
              role="menuitem"
              className={styles.menuItem}
              onClick={() => {
                setOpen(false);
                onNewAbsence();
              }}
            >
              <span className={styles.menuGlyph} aria-hidden="true">
                <IconCalendarPlus size={16} stroke={1.75} />
              </span>
              {t('header.menuAbsences')}
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
