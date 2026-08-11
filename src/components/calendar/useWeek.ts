'use client';

/**
 * The week view's data: one snapshot, one loading state, one paging control.
 *
 * `GET /api/week` is deliberately a single call — the grid needs the days, the blocks
 * with their job's colour, the gaps and the summary to AGREE with each other, and a
 * recomposition rewrites all of them at once. So this hook never merges a mutation's
 * response into local state; it refetches. The API layer is explicit about why: "a
 * recomposition can rewrite rows in any week, so mutation responses deliberately
 * return only the touched entity plus the summary".
 *
 * Paging is a GET. Nothing here can trigger a recomposition, which is what makes
 * moving through the weeks safe to hold an arrow key down on.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { addDays, startOfWeek } from '../../lib/dates';
import { apiErrorMessage, getWeek, isAbortError, type WeekView } from '../../lib/api-client';
import { DEFAULT_LANGUAGE, isLanguage } from '../../lib/i18n';

export interface WeekController {
  /** The week on screen. Kept while the next one loads, so paging does not flash. */
  view: WeekView | null;
  /** A week is in flight. `view` may still hold the previous one. */
  loading: boolean;
  /** A mutation is in flight: the grid stops accepting gestures. */
  busy: boolean;
  /** The week could not be loaded. Translated; the banner offers a retry. */
  loadError: string | null;
  /** A mutation was refused. Translated. */
  actionError: string | null;
  clearActionError: () => void;
  reload: () => void;
  goToday: () => void;
  goPrevious: () => void;
  goNext: () => void;
  /**
   * Runs one mutation, then refetches the week — on success AND on failure, because a
   * refusal means the server's state is the one to trust. Resolves to `undefined` when
   * it failed, having put the translated message in `actionError`.
   */
  mutate: <T>(work: () => Promise<T>) => Promise<T | undefined>;
}

export function useWeek(): WeekController {
  const { t, i18n } = useTranslation();
  const resolved = i18n.resolvedLanguage ?? i18n.language;
  const language = isLanguage(resolved) ? resolved : DEFAULT_LANGUAGE;

  // `null` means "the week the server calls current". Kept null until the owner pages,
  // so the first request does not have to guess the shop's timezone.
  const [reference, setReference] = useState<string | null>(null);
  const [view, setView] = useState<WeekView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);

    getWeek(reference ?? undefined, { signal: controller.signal })
      .then((next) => {
        setView(next);
        setLoadError(null);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return;
        setLoadError(apiErrorMessage(error, t, language));
        setLoading(false);
      });

    return () => controller.abort();
    // `nonce` is the refetch trigger; `t`/`language` only affect the error wording.
  }, [reference, nonce, t, language]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  const mutate = useCallback(
    async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
      setBusy(true);
      setActionError(null);
      try {
        return await work();
      } catch (error) {
        if (isAbortError(error)) return undefined;
        setActionError(apiErrorMessage(error, t, language));
        return undefined;
      } finally {
        setBusy(false);
        // Always resync: a refusal wrote nothing, but a 404 means this screen is stale.
        setNonce((value) => value + 1);
      }
    },
    [t, language],
  );

  // Paging needs a concrete Monday, which only the first response can supply: the
  // shop's "today" is a server fact (Europe/Madrid), never the browser's clock.
  const startDate = view?.week.startDate ?? null;
  const today = view?.today ?? null;

  const goPrevious = useCallback(() => {
    if (startDate === null) return;
    setActionError(null);
    setReference(addDays(startDate, -7));
  }, [startDate]);

  const goNext = useCallback(() => {
    if (startDate === null) return;
    setActionError(null);
    setReference(addDays(startDate, 7));
  }, [startDate]);

  const goToday = useCallback(() => {
    setActionError(null);
    // `null` is "the current week" to the server, which is the honest answer when the
    // page has been open across midnight.
    setReference(today === null ? null : startOfWeek(today));
  }, [today]);

  const clearActionError = useCallback(() => setActionError(null), []);

  return useMemo(
    () => ({
      view,
      loading,
      busy,
      loadError,
      actionError,
      clearActionError,
      reload,
      goToday,
      goPrevious,
      goNext,
      mutate,
    }),
    [
      view,
      loading,
      busy,
      loadError,
      actionError,
      clearActionError,
      reload,
      goToday,
      goPrevious,
      goNext,
      mutate,
    ],
  );
}
