/**
 * Where a popover sits: fixed to the viewport and clipped there, like `.paintChooser`. Kept out of
 * the component so it can be tested without a browser — with six fixed rows the box is a known
 * size, so nothing here is measured.
 */

/** The trigger in viewport coordinates, as a `DOMRect` gives it. */
export interface PopoverAnchor {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface PopoverSize {
  width: number;
  height: number;
}

export interface PopoverViewport {
  width: number;
  height: number;
}

/**
 * Below the trigger while the box fits, above it when it does not, and never outside the viewport:
 * the box is `position: fixed`, so nothing scrolls a bottom row back into reach.
 */
export function popoverPosition(
  anchor: PopoverAnchor,
  size: PopoverSize,
  viewport: PopoverViewport,
  gap: number,
): { top: number; left: number } {
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - size.height;

  return {
    top: bounded(below + size.height <= viewport.height ? below : above, viewport.height - size.height),
    left: bounded(anchor.left, viewport.width - size.width),
  };
}

/** Inside `[0, limit]`, and pinned to 0 when the box is bigger than the viewport (`limit` < 0). */
function bounded(value: number, limit: number): number {
  return Math.max(0, Math.min(value, Math.max(0, limit)));
}
