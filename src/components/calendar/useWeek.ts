'use client';

/**
 * The week view's data. A recomposition can rewrite rows in ANY week, so this hook never merges
 * a mutation's response into local state — it refetches. Paging is a GET, which is what makes
 * it safe to do with a block in hand.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  /**
   * The same fact as `busy`, readable WITHOUT waiting for a render. `busy` is state, so it
   * reaches the grid one render late — and that gap is exactly where the owner's next press
   * lands, starting a real drag against a calendar already being rewritten. The gesture
   * layer asks this at the moment the pointer goes down; see `BeginOptions.inert`.
   */
  mutating: React.MutableRefObject<boolean>;
  /** The week could not be loaded. Translated; the banner offers a retry. */
  loadError: string | null;
  /** A mutation was refused. Translated. */
  actionError: string | null;
  /**
   * Bumped by every refetch of the SAME week — a reload, and the resync after every mutation — and
   * never by a page turn, which changes the week instead. Anything holding data from another
   * request hangs off this: a recomposition rewrites rows the week's own response never mentions.
   */
  revision: number;
  clearActionError: () => void;
  reload: () => void;
  goToday: () => void;
  goPrevious: () => void;
  goNext: () => void;
  /**
   * Show the week this date is in, cancelling a page turn that has not landed yet — the one
   * half state edge paging can produce. A no-op when that week is already shown or in
   * flight.
   */
  showWeekOf: (date: string) => void;
  /**
   * Runs one mutation, then refetches — on success AND on failure, since a refusal means
   * the server's state is the one to trust. `undefined` when it failed, with the translated
   * message in `actionError`.
   */
  mutate: <T>(work: () => Promise<T>) => Promise<T | undefined>;
}

export function useWeek(): WeekController {
  const { t, i18n } = useTranslation();
  const resolved = i18n.resolvedLanguage ?? i18n.language;
  const language = isLanguage(resolved) ? resolved : DEFAULT_LANGUAGE;

  // `null` means "the week the server calls current", so the first request does not have
  // to guess the shop's timezone.
  const [reference, setReference] = useState<string | null>(null);
  const [view, setView] = useState<WeekView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // Set and cleared synchronously around the request, so a press can ask in the same tick.
  const mutating = useRef(false);

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
      mutating.current = true;
      setBusy(true);
      setActionError(null);
      try {
        return await work();
      } catch (error) {
        if (isAbortError(error)) return undefined;
        setActionError(apiErrorMessage(error, t, language));
        return undefined;
      } finally {
        mutating.current = false;
        setBusy(false);
        // Always resync: a refusal wrote nothing, but a 404 means this screen is stale.
        setNonce((value) => value + 1);
      }
    },
    [t, language],
  );

  // Paging needs a concrete Monday, which only the first response can supply: the shop's
  // "today" is a server fact, never the browser's clock.
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
    // `null` is "the current week" to the server — the honest answer when the page has
    // been open across midnight.
    setReference(today === null ? null : startOfWeek(today));
  }, [today]);

  const showWeekOf = useCallback(
    (date: string) => {
      const monday = startOfWeek(date);
      // Setting `reference` for the first time would pin a screen that had deliberately
      // left it null, and cost a GET to say what it already said.
      if (monday === reference) return;
      if (reference === null && monday === startDate) return;
      setReference(monday);
    },
    [reference, startDate],
  );

  const clearActionError = useCallback(() => setActionError(null), []);

  return useMemo(
    () => ({
      view,
      loading,
      busy,
      mutating,
      loadError,
      actionError,
      revision: nonce,
      clearActionError,
      reload,
      goToday,
      goPrevious,
      goNext,
      showWeekOf,
      mutate,
    }),
    [
      view,
      loading,
      busy,
      loadError,
      actionError,
      nonce,
      clearActionError,
      reload,
      goToday,
      goPrevious,
      goNext,
      showWeekOf,
      mutate,
    ],
  );
}
