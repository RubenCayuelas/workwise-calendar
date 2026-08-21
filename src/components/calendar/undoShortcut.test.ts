import { describe, expect, it } from 'vitest';
import { historyShortcut, type Chord, type ShortcutState } from './undoShortcut';

const READY: ShortcutState = {
  typing: false,
  open: false,
  busy: false,
  canUndo: true,
  canRedo: true,
};

function chord(key: string, modifiers: Partial<Chord> = {}): Chord {
  return { key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...modifiers };
}

describe('which press is a shortcut', () => {
  it('takes Ctrl+Z for undo and both spellings of redo', () => {
    expect(historyShortcut(chord('z', { ctrlKey: true }), READY)).toEqual({ action: 'undo' });
    expect(historyShortcut(chord('y', { ctrlKey: true }), READY)).toEqual({ action: 'redo' });
    expect(historyShortcut(chord('z', { ctrlKey: true, shiftKey: true }), READY)).toEqual({
      action: 'redo',
    });
    // An upper-case key arrives with Shift held, and Cmd costs nothing to accept.
    expect(historyShortcut(chord('Z', { ctrlKey: true, shiftKey: true }), READY)).toEqual({
      action: 'redo',
    });
    expect(historyShortcut(chord('z', { metaKey: true }), READY)).toEqual({ action: 'undo' });
  });

  it('leaves every other press alone', () => {
    expect(historyShortcut(chord('z'), READY)).toBeNull();
    expect(historyShortcut(chord('ArrowLeft', { ctrlKey: true }), READY)).toBeNull();
    expect(historyShortcut(chord('Escape'), READY)).toBeNull();
    expect(historyShortcut(chord('x', { ctrlKey: true }), READY)).toBeNull();
    // Alt is nobody's undo, and claiming it would eat a browser shortcut.
    expect(historyShortcut(chord('z', { ctrlKey: true, altKey: true }), READY)).toBeNull();
  });
});

describe('when the shortcut is inert', () => {
  it('gives way to the field the owner is typing in, before anything else', () => {
    expect(historyShortcut(chord('z', { ctrlKey: true }), { ...READY, typing: true })).toEqual({
      blocked: 'typing',
    });
    // Even with nothing to undo: inside a field the press is the browser's, and the answer
    // must not depend on the state of the line.
    expect(
      historyShortcut(chord('z', { ctrlKey: true }), { ...READY, typing: true, canUndo: false }),
    ).toEqual({ blocked: 'typing' });
  });

  it('stands aside for an open panel or dialog, and says which', () => {
    expect(historyShortcut(chord('z', { ctrlKey: true }), { ...READY, open: true })).toEqual({
      blocked: 'open',
    });
    expect(historyShortcut(chord('y', { ctrlKey: true }), { ...READY, open: true })).toEqual({
      blocked: 'open',
    });
  });

  it('waits while a save is in flight', () => {
    expect(historyShortcut(chord('z', { ctrlKey: true }), { ...READY, busy: true })).toEqual({
      blocked: 'busy',
    });
  });

  it('reports an empty line per direction', () => {
    expect(historyShortcut(chord('z', { ctrlKey: true }), { ...READY, canUndo: false })).toEqual({
      blocked: 'empty',
    });
    expect(historyShortcut(chord('y', { ctrlKey: true }), { ...READY, canUndo: false })).toEqual({
      action: 'redo',
    });
    expect(historyShortcut(chord('y', { ctrlKey: true }), { ...READY, canRedo: false })).toEqual({
      blocked: 'empty',
    });
  });
});
