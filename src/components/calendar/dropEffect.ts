/**
 * What a drop will do to the row it lands ON, worked out while the pointer is still
 * down.
 *
 * WHY THIS EXISTS. A drop used to be, for a weekday row, a pure re-ranking: the row
 * took a place in the queue and settled after whatever preceded it, so the ghost's
 * exact minutes were never a promise and nothing else on the day changed. Since
 * 2026-08-12 an overlapping drop CUTS the row underneath (CLAUDE.md, *A Drop That
 * Overlaps*), on any day — so the drop now rewrites somebody else's block, and the
 * preview has to say so before the mouse is released rather than after, in a toast.
 *
 * It mirrors `resolveManualPlacement`, which is the authority; this is a read-only
 * echo of its two branches:
 *
 * | the drop is…                                  | it collides with… | same job | other job |
 * |-----------------------------------------------|-------------------|----------|-----------|
 * | PINNED (weekend, the Friday buffer, a margin, the lunch band, or locked) | the day's FIXED rows | merged, hours summed | cut, tail pushed after |
 * | RE-RANKED (Mon-Thu inside the periods, unlocked) | the day's MOVABLE rows | nothing — the reflow lays them out contiguously and auto-merge joins them | cut, but only a row that STARTS BEFORE the drop |
 *
 * FRIDAY IS ON THE PINNED SIDE because a drop there PADLOCKS the row, which takes it out
 * of the movable pool — that is how work stays on the colchón at all. So is any row that
 * already carries a padlock, whatever day it is on.
 *
 * and a LOCKED row is never overlapped: on the pinned side that is the 409
 * `overlaps-locked-block`, on the re-ranked side the row is simply ignored, because
 * flexible work flows around it.
 *
 * THE TWO QUESTIONS ARE NOT THE SAME QUESTION, and conflating them is what made the ghost
 * lie in both directions (measured 2026-08-13, reconciled 2026-08-14):
 *
 * - "DOES THE ROW KEEP THE MINUTE?" is `dropPins`, the mirror of `pinsTheRow` in
 *   src/lib/operations/blocks.ts. The Friday buffer, the weekend, a locked unit — and, on
 *   EVERY day including Monday, a footprint that reaches a visual margin or the lunch band.
 * - "MAY THE DROP BE REFUSED FOR A COLLISION?" is `dayReflowsOn`, the mirror of `dayReflows`
 *   in src/lib/composition.ts. Only where the engine does NOT lay the day out: the weekend,
 *   a closed day, the frozen past — plus a locked unit on any day.
 *
 * Read off one predicate, a Friday drop onto a gap was previewed as a refusal the server
 * now accepts, and a Monday drop into the lunch band over a gap was previewed as a harmless
 * re-rank while the server slid it forward past the gap. `resolveDropPreview` asks both, in
 * the server's own order, and applies the server's own slide.
 *
 * THE DROP'S FOOTPRINT IS ITS SEGMENTS, not the rectangle the pointer draws. A drop is
 * stored cut at the break between two working periods (CLAUDE.md, *A Drop Is Stored In
 * Segments*), so 6 h released at 10:00 occupies 10:00-14:00 and 15:30-17:30 and NOT the
 * lunch band between them. That rule is `segmentDroppedRow` in src/lib/dropSegments.ts,
 * imported rather than restated: the engine and this file must give the same answer, and
 * a row sitting inside the lunch band would otherwise be announced as cut by a drop that
 * never touches it.
 *
 * TWO APPROXIMATIONS, both deliberate and both safe in the same direction — they can
 * only make the preview silent, never make it promise something that will not happen:
 *
 * - a unit stored as two rows around lunch is dropped one row at a time, and this
 *   reads the ghost (the unit's whole span) rather than each row's own;
 * - the past is not modelled at all, because a drop onto a past day is refused by the
 *   drag layer before it gets here.
 */

import { overlapsSegments, segmentDroppedRow, type DropSegment } from '../../lib/dropSegments';
import { firstClearStart } from '../../lib/dropSlide';
import {
  dayEndMinutes,
  netMinutesBetween,
  netMinutesOf,
  usesManualOnlyTime,
} from '../../lib/manualWindow';
import type { DayRole } from '../../lib/composition';
import type { WorkPeriod } from '../../types';

/** The row shapes this needs. `WeekBlock` satisfies it; a test can build one by hand. */
export interface DropRow {
  id: string;
  projectId: string;
  startMinutes: number;
  durationMinutes: number;
  /** The engine will not move it: the padlock, whoever's gesture set it. */
  locked: boolean;
  project: { name: string };
}

export interface DropEffectInput {
  /** Every row already on the TARGET day, the dragged unit's own rows included. */
  rows: readonly DropRow[];
  /**
   * The GAPS on the target day. Gaps and blocks are one occupancy set, and a drop that
   * pins — the buffer, the weekend, a margin, the lunch band — is refused when it lands on
   * one (409 `overlaps-gap`), exactly as a gap over a padlocked row is refused. On
   * Monday-Thursday the reflow keeps auto work off a gap by itself, so nothing is said.
   */
  gaps?: readonly { startMinutes: number; durationMinutes: number }[];
  /** The dragged unit's rows: they cannot collide with themselves. */
  movingBlockIds: readonly string[];
  /** The dragged unit's job, which decides merge versus cut. */
  projectId: string;
  /** Every row of a weekend day is fixed, whatever its padlock says. */
  dayIsWeekend: boolean;
  /**
   * THE DROP KEEPS THE MINUTE IT IS RELEASED ON — `dropPins`, the mirror of `pinsTheRow`.
   * It picks the SIDE the collision is resolved on, exactly as `isMovable(placed)` does in
   * `resolveManualPlacement`: a pinned drop collides with the day's fixed rows, an
   * unpinned one with its movable rows.
   *
   * Not the same thing as `dayReflows` below. The Friday buffer pins AND reflows; a
   * Monday drop that reaches the lunch band pins on a day that reflows.
   */
  pinned: boolean;
  /**
   * THE ENGINE LAYS THIS DAY OUT — `dayReflowsOn`, the mirror of `dayReflows`. When it is
   * true a drop can never be refused for a collision: it is a re-ranking of the queue and
   * the reflow is what finds the room. Only a day the engine never writes to — the
   * weekend, a closed day, the frozen past — makes a collision permanent and a refusal
   * honest.
   */
  dayReflows: boolean;
  /** The dragged unit is locked, so the reflow will not lay it out either. */
  locked: boolean;
  /**
   * The target day's MANUAL WINDOWS — the periods with the visual margins fused on, which
   * is the view every hand action is cut over (src/lib/manualWindow.ts). Without them a
   * drop across the lunch break would be measured over the band it does not occupy.
   */
  manualWindows: readonly WorkPeriod[];
  /** The ghost, in minutes from midnight. */
  startMinutes: number;
  durationMinutes: number;
}

export type DropEffectKind =
  /** The row underneath is cut here and its tail continues after the drop. */
  | 'cut'
  /**
   * The row underneath is covered from its very start, so there is no head to leave
   * behind: it is not cut, it is moved whole to after the drop.
   *
   * Told apart from `cut` because the sentence was a lie in the one case the owner is
   * most likely to make it — releasing exactly on top of a short row — and a toast that
   * says a job was split when it was not teaches the owner to distrust the others.
   */
  | 'displace'
  /** The same job's row absorbs the drop: one row, hours SUMMED. */
  | 'merge'
  /** A locked row is in the way. The save is refused (409) and nothing is written. */
  | 'blocked'
  /** A GAP is in the way, on a day that pins. Refused (409), nothing is written. */
  | 'gap';

export interface DropEffect {
  kind: DropEffectKind;
  /** The row this happens to. Empty for a gap, which is not a row of any job. */
  blockId: string;
  /** Its job's name, so the hint can name it the way the toast afterwards will. */
  projectName: string;
  /** Where the row is cut, in minutes from midnight. Only meaningful for `cut`. */
  cutMinutes: number;
}

/**
 * DOES THIS DROP KEEP THE MINUTE IT WAS RELEASED ON, OR ONLY A PLACE IN THE QUEUE?
 *
 * The mirror of `pinsTheRow` (src/lib/operations/blocks.ts) with the padlock added, which
 * is the whole of the server's answer: a locked unit never moves, so honouring the padlock
 * means honouring the slot. Branch for branch —
 *
 * - PINNED: a locked unit, or a day the engine does not lay out (`role !== 'auto'`: the
 *   Friday colchón and the weekend), or a footprint that asks for MANUAL-ONLY TIME — a
 *   visual margin or the lunch band — on ANY day, Monday included, because the engine's
 *   index space has no margin minutes in it and an unpinned margin row is pulled straight
 *   back inside the periods.
 * - RE-RANKED otherwise: the drop writes a place in the queue and the reflow decides the
 *   clock, so the ghost's minutes are an AIM rather than a promise.
 *
 * Everything the owner was fighting came from the two being drawn the same way: a ghost
 * reading `09:00–14:00` over Thursday, released, and the row settling on Wednesday at
 * 12:00 — the app looked like it had ignored the drag. See `WeekGrid`'s ghost.
 *
 * It is the drop's INTENT, not the last word: on a day the engine reflows the server may
 * slide a pinned drop forward, or hand it back as a plain rank. `resolveDropPreview`
 * applies both, from the same shared arithmetic the server uses.
 */
export function dropPins(input: {
  /** The dragged unit is locked, so the reflow will not lay it out either. */
  locked: boolean;
  /** `auto` Mon-Thu, `buffer` Friday, `manual` Sat/Sun — `WeekDay.role`. */
  role: DayRole;
  /** The day's WORKING periods: the minutes auto-fill may use, margins excluded. */
  periods: readonly WorkPeriod[];
  /** The periods with the margins fused on: the view a hand action is cut over. */
  manualWindows: readonly WorkPeriod[];
  startMinutes: number;
  durationMinutes: number;
}): boolean {
  if (input.locked || input.role !== 'auto') return true;
  return usesManualOnlyTime(
    input.periods,
    segmentDroppedRow(input.manualWindows, {
      startMinutes: input.startMinutes,
      durationMinutes: input.durationMinutes,
    }),
  );
}

/**
 * DOES THE ENGINE LAY THIS DAY OUT? The mirror of `dayReflows` (src/lib/composition.ts),
 * asked of what a `WeekDay` carries so the grid does not have to import the engine.
 *
 * It is the predicate that says whether a drop here may be REFUSED for a collision, and it
 * is deliberately NOT the pin question. On a day the engine reflows a drop is not a literal
 * placement, it is a re-ranking of the queue, and asking "does the footprint fit here as
 * the calendar stands right now" has a circular answer: moving the row off its current day
 * frees the space there, everything behind it shifts earlier, and THAT is what opens the
 * room on the target day. The owner's report, exactly: «si lo intento pasar al día
 * siguiente en el que ahora no hay hueco pero si lo muevo se recalcula y queda disponible,
 * no lo puedo asignar directamente porque "aún no cabe"».
 */
export function dayReflowsOn(day: { role: DayRole; isClosed: boolean; isPast: boolean }): boolean {
  return !day.isClosed && day.role !== 'manual' && !day.isPast;
}

/** A row as the QUEUE sees it: a job, a rank, and the flag that takes it out. */
export interface QueueRow {
  id: string;
  date: string;
  startMinutes: number;
  locked: boolean;
  project: { name: string };
}

/**
 * THE ROW A RE-RANKED DROP WILL FALL IN BEHIND, or `null` when nothing in the week
 * precedes it.
 *
 * This is the only honest thing a ghost can say on a day the engine reflows. The engine's
 * queue is the MOVABLE rows in (date, start) order — `QueueItem` in src/lib/composition.ts:
 * "movable order is preserved by the reflow" — so the row immediately before the release
 * point is the row the drop ranks itself after, whatever day the packer then lays it out
 * on. Naming it turns "09:00–14:00" (which the drop will not produce) into "tras
 * «Escalera»" (which is exactly what the drop means).
 *
 * `null` is returned rather than "it goes first" when nothing is found: the queue reaches
 * back before the week on screen, and a ghost has no business claiming a rank it cannot
 * see. The caller says the generic sentence then.
 */
export function dropPredecessor(
  /** Every MOVABLE row of the visible week, in queue order — see `buildDropQueue`. */
  queue: readonly QueueRow[],
  movingBlockIds: readonly string[],
  date: string,
  startMinutes: number,
): QueueRow | null {
  let found: QueueRow | null = null;
  for (const row of queue) {
    if (movingBlockIds.includes(row.id)) continue;
    if (row.date > date || (row.date === date && row.startMinutes >= startMinutes)) break;
    found = row;
  }
  return found;
}

/**
 * The week's movable rows in queue order: the pool the reflow lays out, and therefore the
 * only rows a rank can be expressed against.
 *
 * A row is out of it for exactly the reasons the engine leaves it where it is — a padlock,
 * or a day the engine never writes to at all (the past and the weekend).
 * The Friday colchón is NOT one of those: an engine-placed Friday row is still movable and
 * the reflow can pull it back, which is why the buffer does not appear here even though
 * it decides whether a drop ONTO Friday pins (`dropPins`).
 */
export function buildDropQueue(
  rows: readonly QueueRow[],
  isReflowingDate: (date: string) => boolean,
): QueueRow[] {
  return rows
    .filter((row) => !row.locked && isReflowingDate(row.date))
    .sort(
      (a, b) =>
        (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) ||
        a.startMinutes - b.startMinutes ||
        (a.id < b.id ? -1 : 1),
    );
}

/** What the drop will really be, once the server has had its say. */
export interface DropResolution {
  /**
   * The minute the row will be STORED at — the release point, moved forward past the gaps
   * and locks the server will not let it share minutes with (`firstClearStart`). Equal to
   * the release point for every drop that was already clear, which is nearly all of them,
   * and meaningless when `pinned` is false (there the reflow picks the clock).
   */
  startMinutes: number;
  /**
   * The row keeps `startMinutes` — and, since 2026-08-14, comes back with a padlock on it.
   * False for a drop the engine still owns, which is a queue rank instead.
   */
  pinned: boolean;
  /**
   * The server moved the drop DOWN the day to get clear of a gap or a lock, so the ghost
   * is no longer under the pointer. Said out loud: a rectangle that jumps away from the
   * hand and explains nothing is the same defect as one that freezes (`clamped`).
   */
  slid: boolean;
  /** What it does to the row underneath, or `null` when it disturbs nothing. */
  effect: DropEffect | null;
}

/**
 * THE WHOLE ANSWER THE GHOST NEEDS, in the server's own order.
 *
 * `resolveManualPlacement` resolves a drop in two steps and the preview has to walk the
 * same two or it will promise something else:
 *
 *  1. a drop the engine still owns — not pinned — is a queue RANK. Nothing is refused and
 *     the minutes are an aim rather than a promise.
 *  2. a drop that PINS is padlocked, so it lands literally. On a day the engine lays out it
 *     is SLID forward to the first slot clear of a gap and of a lock (`firstClearStart`,
 *     shared with the engine) — that is what makes a Friday drop land on that Friday, since
 *     a rank there would be pulled straight back into Mon-Thu. A day with no such slot
 *     keeps the release point and the refusal stands: the pin cannot be given up, because
 *     it IS the padlock. On the weekend, a closed day and the past there is no slide at
 *     all.
 */
export function resolveDropPreview(input: DropEffectInput): DropResolution {
  if (!input.pinned || !input.dayReflows) {
    return {
      startMinutes: input.startMinutes,
      pinned: input.pinned,
      slid: false,
      effect: dropEffectOf(input),
    };
  }

  const slid = firstClearStart({
    windows: input.manualWindows,
    immovable: [
      ...(input.gaps ?? []),
      ...input.rows.filter((row) => row.locked && !input.movingBlockIds.includes(row.id)),
    ].map((row) => ({ startMinutes: row.startMinutes, durationMinutes: row.durationMinutes })),
    startMinutes: input.startMinutes,
    durationMinutes: input.durationMinutes,
  });

  if (slid === null) {
    // Nowhere on this day to get clear, so the drop stays exactly where it was released
    // and whatever is in the way is what the hint names — the server refuses it there.
    return {
      startMinutes: input.startMinutes,
      pinned: true,
      slid: false,
      effect: dropEffectOf(input),
    };
  }
  const settled = { ...input, startMinutes: slid };
  return {
    startMinutes: slid,
    pinned: true,
    slid: slid !== input.startMinutes,
    effect: dropEffectOf(settled),
  };
}

/**
 * The one thing worth drawing, or `null` when the drop disturbs nothing.
 *
 * One effect rather than a list: a drop can legally cut several rows at once, but the
 * hint has room for one sentence and the first row the drop lands in is the one the
 * pointer is actually over. A refusal always wins, because it is the only outcome
 * where nothing is saved at all.
 *
 * Callers on the grid go through `resolveDropPreview`, which asks this at the minute the
 * row will really be stored at. Asked directly it answers about the minute it is given.
 */
export function dropEffectOf(input: DropEffectInput): DropEffect | null {
  // The clock the drop will really hold once it is stored: its segments, with the break
  // it skips left out of them.
  const footprint = dropFootprint(input);
  // The drop's own side of the calendar: a pinned drop lands where the reflow may not
  // reach, so it collides with the other fixed rows and nothing will separate them.
  const reflowed = !input.pinned;

  const overlapping = [...input.rows]
    .filter(
      (row) =>
        !input.movingBlockIds.includes(row.id) &&
        overlapsSegments(footprint, row.startMinutes, row.durationMinutes) &&
        // Each branch only ever sees its own side. `isMovable` reduces to this here:
        // the day is not past (the drag layer refuses those), so a row is fixed iff the
        // day is a weekend or the row is padlocked.
        (input.dayIsWeekend || row.locked) !== reflowed,
    )
    .sort((a, b) => a.startMinutes - b.startMinutes || (a.id < b.id ? -1 : 1));

  if (reflowed) {
    // A row starting at or after the drop already ranks behind it and is left alone;
    // a locked row was filtered out above, so no drop on this side is ever refused. A GAP
    // is not mentioned either: the reflow keeps auto work off it without being asked.
    const victim = overlapping.find(
      (row) => row.projectId !== input.projectId && row.startMinutes < input.startMinutes,
    );
    return victim === undefined ? null : effect('cut', victim, input.startMinutes);
  }

  // The fixed side, in the server's own order. The SAME job folds first, padlocks and all
  // — the hours are the owner's own and the merged row keeps the padlock. Then the two
  // REFUSALS, the only outcomes where nothing at all is saved: another job's lock in the
  // way, and a gap under the drop, since gaps and blocks are one occupancy set and on a day
  // that pins nothing will ever separate them. Then the cut.
  const sameJob = overlapping.find((row) => row.projectId === input.projectId);
  if (sameJob !== undefined) return effect('merge', sameJob, input.startMinutes);

  const locked = overlapping.find((row) => row.locked);
  if (locked !== undefined) return effect('blocked', locked, input.startMinutes);

  const covered = (input.gaps ?? []).find((candidate) =>
    overlapsSegments(footprint, candidate.startMinutes, candidate.durationMinutes),
  );
  if (covered !== undefined) return { kind: 'gap', blockId: '', projectName: '', cutMinutes: input.startMinutes };

  const victim = overlapping[0];
  if (victim === undefined) return null;
  // Nothing is left in FRONT of the drop, so there is no head to leave behind: the server
  // deletes the row and re-places its whole duration after the drop, reusing its id
  // (`spareIds`). Calling that a split is the one lie the owner catches immediately.
  const kind = input.startMinutes <= victim.startMinutes ? 'displace' : 'cut';
  return effect(kind, victim, Math.max(victim.startMinutes, input.startMinutes));
}

function effect(kind: DropEffectKind, row: DropRow, cutMinutes: number): DropEffect {
  return { kind, blockId: row.id, projectName: row.project.name, cutMinutes };
}

/**
 * The rows the drop will be stored as — what the ghost should draw, and what the
 * collision test above measures against.
 *
 * Exported because WeekGrid draws the ghost from it: one rectangle per segment, so the
 * preview shows the two rows the server will write rather than one rectangle running
 * through the lunch band.
 */
export function dropFootprint(input: {
  manualWindows: readonly WorkPeriod[];
  startMinutes: number;
  durationMinutes: number;
}): DropSegment[] {
  return segmentDroppedRow(input.manualWindows, {
    startMinutes: input.startMinutes,
    durationMinutes: input.durationMinutes,
  });
}

/**
 * THE FOOTPRINT AS IT IS DRAWN: the same segments, with anything the day cannot hold left
 * off the end.
 *
 * `dropFootprint` is the STORAGE answer and it has one documented latitude that a drawing
 * may not have — a stretch whose tail would pass midnight is returned UNCUT
 * (`segmentDroppedRow`, and CLAUDE.md *A Drop Is Stored In Segments*), so the server can
 * refuse the drop as it was made rather than store half of it. For a multi-day RUN that is
 * the ordinary case, not the exotic one: the drag unit is the whole run, so an 18 h run
 * released at 07:00 came back as one segment of 1080 minutes and the ghost drew ONE
 * rectangle from the top of the axis to the bottom of it — straight through the compressed
 * lunch band, over the hatch that exists to say nothing lives there.
 *
 * CLAUDE.md is explicit that this is not allowed (*Calendar View -> Drag-drop*): "the ghost
 * is drawn in segments, one rectangle per row the gesture will be stored as, because one
 * rectangle straight through the grey band promises a shape that will never exist". So the
 * drawing is capped at the NET MINUTES THIS DAY CAN STILL HOLD from that start, which puts
 * the shape back inside the rules: cut at the break, ending no later than the day does.
 *
 * It changes nothing for a gesture that fits — nearly all of them — because then the cap is
 * above the duration and this is `dropFootprint` exactly. What the owner sees for a run that
 * does not fit is the day filled from the release point with the band left clear, which is
 * what the label beside it already says in words (`grid.dropLongerThanDay`): this much
 * today, and it does not end today.
 *
 * IT IS DELIBERATELY NOT USED FOR THE COLLISION TEST. `dropEffectOf` measures overlaps
 * against the uncut footprint, and narrowing that would change which cut, merge or refusal
 * the ghost announces — a behavioural question about what dragging an over-long run should
 * DO, not a question about what shape to draw. It is recorded as an open question in
 * DECISIONS.md rather than answered here.
 */
export function footprintWithinDay(input: {
  manualWindows: readonly WorkPeriod[];
  startMinutes: number;
  durationMinutes: number;
}): DropSegment[] {
  const holds = netMinutesBetween(
    input.manualWindows,
    input.startMinutes,
    dayEndMinutes(input.manualWindows),
  );
  // A start inside a hole (the lunch band, or past the last window) has no working minutes
  // ahead of it on this measure, and its own latitude not to be cut. Left to
  // `dropFootprint`, which draws it as the one rectangle it will really be stored as.
  if (holds <= 0 || input.durationMinutes <= holds) return dropFootprint(input);
  return dropFootprint({ ...input, durationMinutes: holds });
}

/**
 * THE CLOCK MINUTE THE GESTURE ENDS AT — or `null` when it does not end on this day at all.
 *
 * `durationMinutes` is NET WORKING MINUTES, and net minutes are not a span on the clock:
 * `start + duration` is an end-of-day reading ONLY while every one of those minutes fits
 * inside the day from that start. Where they do not, there is no end time to print, and
 * inventing one is a category error rather than an off-by-something:
 *
 * - THE DRAG UNIT IS THE RUN (CLAUDE.md, *The Unit of a Drag Is the RUN*), so a ghost's
 *   duration is the run's total ACROSS DAYS. An 18 h run released at 07:00 gave
 *   `420 + 1080 = 1500` — 25:00 — which `formatTime` refused, printed as `--:--`, and
 *   complained about once per pointer move. A run does not end at a time of day; it ends
 *   on a later DAY.
 * - Short of that, a stretch that merely OVERRUNS the day reads as a plausible hour and is
 *   worse for it: 13 h at 07:00 comes out as 21:30 on the documented shift, an hour past
 *   every rule the grid draws, and nothing on screen says so.
 *
 * THE LINE IS `dayEndMinutes` — the end of the day's last manual window, the same line no
 * stored row may cross (CLAUDE.md, *The End of the Day Is a Line No Write May Cross*). A
 * caller that gets `null` has to say something other than a time; see the ghost's label in
 * WeekGrid, which falls back to naming the START and the hours, both of which are true.
 */
export function footprintEnd(input: {
  manualWindows: readonly WorkPeriod[];
  startMinutes: number;
  durationMinutes: number;
}): number | null {
  const segments = dropFootprint(input);
  const last = segments[segments.length - 1];
  const end = last.startMinutes + last.durationMinutes;
  return end > dayEndMinutes(input.manualWindows) ? null : end;
}

/**
 * Can this day hold `durationMinutes` of work from ANY start? Its whole manual window —
 * the periods plus the margins — against the gesture's net minutes.
 *
 * The question the drag layer's clamp cannot answer for itself: `latestStartFor` falls back
 * to the first window's start when nothing fits, so a clamp reports "the latest start" for
 * a run no start could hold, and the ghost then reads «18 h no pueden empezar después de
 * las 07:00» — which says 07:00 would work. It would not.
 */
export function dayHoldsMinutes(
  manualWindows: readonly WorkPeriod[],
  durationMinutes: number,
): boolean {
  return durationMinutes <= netMinutesOf(manualWindows);
}
