/**
 * What a finished creation SAYS, once the form has closed on itself. A kind per sentence, so the
 * wording is chosen in one place and can be tested without a browser.
 */

import { placementHighlights, placementTone, type PlacementChange, type PlacementOutcome } from './placement';
import type { CreationOutcome } from '../../lib/api-client';
import type { BannerTone } from '../ui';

/** One sentence under the rows, as the key that spells it. */
export type CreationHint = 'day.bufferHint' | 'jobForm.createdLocked' | 'jobForm.createdDayLocked';

export interface CreationAnnouncement {
  tone: BannerTone;
  /** The rows worth naming, already capped. */
  rows: PlacementChange[];
  hints: CreationHint[];
}

/**
 * `placement` is the server's answer and is absent on an undated job. A padlock nobody asked for is
 * explained HERE, where it was decided, rather than left to be found as a glyph on the calendar.
 */
export function announceCreation(
  outcome: PlacementOutcome,
  placement?: CreationOutcome,
): CreationAnnouncement {
  const hints: CreationHint[] = [];
  if (outcome.usedBuffer) hints.push('day.bufferHint');

  // At most one padlock sentence: `autoLock` already says every row is fixed, so the narrower
  // `dayLock` under it would only repeat the part the owner has read.
  if (placement?.autoLock === true) hints.push('jobForm.createdLocked');
  else if (placement?.dayLock === true) hints.push('jobForm.createdDayLocked');

  return { tone: placementTone(outcome), rows: placementHighlights(outcome), hints };
}
