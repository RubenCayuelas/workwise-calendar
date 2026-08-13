'use client';

/**
 * The home screen IS the week view — the workshop opens the app to see how long it is
 * booked for, so there is nothing to put in front of that.
 *
 * This file is only the wiring. `CalendarScreen` owns the grid, the gestures and the
 * week's data; the job panel, the create-job form, the gap form and the split form are
 * separate screens that all share one `SidePanel` slot on the right. They plug in
 * through `CalendarScreen`'s render props, which hand each one the week's own facts
 * (the shop's `today`, the summary strip, the shift shape) so no form re-fetches or
 * guesses at them.
 *
 * TWO RULES THIS FILE EXISTS TO HONOUR:
 *
 * 1. `onChanged` refetches the week, and every panel calls it after a save or a delete.
 *    A recomposition rewrites rows in weeks this screen is not even showing, so nothing
 *    is ever patched into local state.
 * 2. AT MOST ONE PANEL AT A TIME — they occupy the same slot. The job panel therefore
 *    steps aside while the split form is open, and comes back when it closes.
 */

import { useState } from 'react';
import { CalendarScreen } from '../src/components/calendar';
import { GapPanel, JobPanel, NewJobPanel, SplitBlockPanel } from '../src/components/jobs';
import type { Block } from '../src/lib/api-client';

export default function HomePage(): React.JSX.Element {
  /**
   * The row the job panel's scissors named. The calendar's own scissors can only reach
   * a row inside the week on screen; this is how a row in another week gets split.
   */
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
      renderGapForm={({
        gap,
        closeDay,
        close,
        onChanged,
        today,
        shape,
        gapColor,
        defaultDate,
        horizonWeeks,
      }) => (
        <GapPanel
          open
          gap={gap ?? undefined}
          // "Stop the day here" is the same gap, pre-filled: same panel, same endpoint.
          closeDay={closeDay ?? undefined}
          today={today}
          shape={shape}
          gapColor={gapColor}
          defaultDate={defaultDate}
          horizonWeeks={horizonWeeks}
          onClose={close}
          onChanged={onChanged}
          onDeleted={close}
        />
      )}
    />
  );
}
