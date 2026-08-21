/**
 * Which of the two shortcuts a press is, and why it does nothing when it does nothing. Kept out
 * of the screen because the suite runs in node with no DOM, and the guard set is the part worth
 * pinning: `typing` decides whether the browser's own undo keeps the press.
 */

export type HistoryAction = 'undo' | 'redo';

/** Why a press that WAS one of the shortcuts did nothing. */
export type HistoryBlock = 'typing' | 'open' | 'busy' | 'empty';

export interface ShortcutState {
  /** The keyboard belongs to a form control, so Ctrl+Z is the browser's. */
  typing: boolean;
  /** A panel, a dialog or a gesture in the air owns the calendar. */
  open: boolean;
  /** A save is in flight. */
  busy: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

/** A keyboard event, narrowed to what the decision reads. */
export interface Chord {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export type ShortcutIntent = { action: HistoryAction } | { blocked: HistoryBlock };

/**
 * `null` means the press is not ours and must be left entirely alone — no `preventDefault`.
 * A `blocked` answer is still ours: it says nothing happens and why.
 */
export function historyShortcut(chord: Chord, state: ShortcutState): ShortcutIntent | null {
  const action = actionOf(chord);
  if (action === null) return null;
  // Typing comes FIRST and outranks the state of the line: inside a field the press belongs to
  // the browser, and answering anything else there would lose what was being written.
  if (state.typing) return { blocked: 'typing' };
  if (state.open) return { blocked: 'open' };
  if (state.busy) return { blocked: 'busy' };
  if (action === 'undo' ? !state.canUndo : !state.canRedo) return { blocked: 'empty' };
  return { action };
}

function actionOf(chord: Chord): HistoryAction | null {
  // Cmd is accepted beside Ctrl at no cost. Alt is nobody's undo, and claiming it would eat a
  // browser shortcut.
  if (chord.altKey || !(chord.ctrlKey || chord.metaKey)) return null;
  const key = chord.key.toLowerCase();
  if (key === 'y') return 'redo';
  if (key !== 'z') return null;
  return chord.shiftKey ? 'redo' : 'undo';
}
