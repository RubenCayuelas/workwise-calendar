'use client';

/**
 * Wiring only. Two rules it exists to honour:
 *
 * 1. `onChanged` REFETCHES the week and every panel calls it after a save. A recomposition
 *    rewrites rows in weeks not on screen, so nothing is ever patched into local state.
 * 2. At most one panel at a time — they share one `SidePanel` slot.
 */

import { useState } from 'react';
import { CalendarScreen } from '../src/components/calendar';
import { AbsencePanel, JobPanel, NewJobPanel, SplitBlockPanel } from '../src/components/jobs';
import type { Block } from '../src/lib/api-client';

export default function HomePage(): React.JSX.Element {
  /** How a row in ANOTHER week gets split: the calendar's own scissors only reach this week. */
  const [splitting, setSplitting] = useState<Block | null>(null);

  return (
    <CalendarScreen
      renderJobPanel={({ projectId, close, onChanged, today, horizonWeeks }) =>
        // Compared against the open job, not just checked for null: closing the panel
        // (or deleting the job) must never leave a row from a previous job armed here.
        splitting === null || splitting.projectId !== projectId ? (
          <JobPanel
            open
            projectId={projectId}
            today={today}
            onClose={() => {
              setSplitting(null);
              close();
            }}
            onChanged={onChanged}
            onDeleted={() => {
              setSplitting(null);
              close();
            }}
            onSplitBlock={setSplitting}
          />
        ) : (
          <SplitBlockPanel
            open
            block={splitting}
            today={today}
            horizonWeeks={horizonWeeks}
            onClose={() => setSplitting(null)}
            onChanged={onChanged}
            // Back to the job panel, which reloads and shows the two new rows.
            onSplit={() => setSplitting(null)}
          />
        )
      }
      renderNewJob={({ close, onChanged, today, summary, suggestedColor, horizonWeeks }) => (
        <NewJobPanel
          open
          today={today}
          summary={summary}
          defaultColor={suggestedColor}
          horizonWeeks={horizonWeeks}
          onClose={close}
          onChanged={onChanged}
        />
      )}
      renderAbsenceForm={({
        gap,
        closeDay,
        kind,
        close,
        onChanged,
        today,
        shape,
        gapColor,
        defaultDate,
        defaultReason,
        defaultStartMinutes,
        defaultDurationMinutes,
        horizonWeeks,
      }) => (
        <AbsencePanel
          open
          gap={gap ?? undefined}
          // "Stop the day here" is the same gap, pre-filled: same panel, same endpoint.
          closeDay={closeDay ?? undefined}
          defaultKind={kind}
          today={today}
          shape={shape}
          gapColor={gapColor}
          defaultDate={defaultDate}
          defaultReason={defaultReason}
          defaultStartMinutes={defaultStartMinutes}
          defaultDurationMinutes={defaultDurationMinutes}
          horizonWeeks={horizonWeeks}
          onClose={close}
          onChanged={onChanged}
          onDeleted={close}
        />
      )}
    />
  );
}
