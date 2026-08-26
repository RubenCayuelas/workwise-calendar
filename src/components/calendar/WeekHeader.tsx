'use client';

/** Paging is a GET, so holding the arrow keys down is safe. */

import { useTranslation } from 'react-i18next';
import { useRouter } from 'next/navigation';
import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconCalendarPlus,
  IconChevronLeft,
  IconChevronRight,
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
  const router = useRouter();

  return (
    <header className="ww-app__header">
      <div className={styles.flank}>
        <Logo />
      </div>

      {/* No aria-label: a second landmark would only compete with the grid's own. */}
      <nav className={styles.pager}>
        <IconButton
          icon={<IconChevronLeft size={18} stroke={1.75} />}
          label={t('header.previousWeek')}
          className={styles.pagerButton}
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
          className={styles.pagerButton}
          disabled={disabled}
          onClick={onNext}
        />
      </nav>

      <div className={`${styles.flank} ${styles.flankEnd} ww-toolbar`}>
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
        <Button
          icon={<IconCalendarPlus size={15} stroke={1.75} />}
          title={t('header.absencesHint')}
          disabled={onNewAbsence === undefined}
          onClick={onNewAbsence}
        >
          {t('header.absences')}
        </Button>
        <LanguageSwitcher />
        <IconButton
          icon={<IconSettings size={18} stroke={1.75} />}
          label={t('header.settings')}
          onClick={() => router.push(settingsHref)}
        />
      </div>
    </header>
  );
}
