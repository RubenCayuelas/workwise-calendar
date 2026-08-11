'use client';

import { useEffect, useState } from 'react';

/**
 * False during the server render and the first client render, true afterwards.
 *
 * The portal-based overlays need it: `document.body` does not exist while rendering
 * on the server, and creating the portal during hydration would make the client's
 * first tree differ from the server's.
 */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
