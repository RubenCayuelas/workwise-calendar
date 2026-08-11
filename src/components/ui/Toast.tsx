'use client';

/**
 * Transient messages. `ToastProvider` is already mounted in `app/layout.tsx`, so a
 * screen only needs `useToast()`.
 *
 *     const toast = useToast();
 *     toast.success(t('jobPanel.saved'));
 *     toast.error(apiErrorMessage(error, t, language));
 *
 * Errors do NOT auto-dismiss: a refused save is something the owner has to read, and
 * a message that vanishes is a message that was never delivered. Everything else
 * clears itself after a few seconds.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { InlineBanner, type BannerTone } from './InlineBanner';
import { useMounted } from './useMounted';
import styles from './Toast.module.css';

export interface ToastInput {
  /** Already translated. */
  message: ReactNode;
  tone?: BannerTone;
  title?: string;
  /** Milliseconds. `0` means it stays until dismissed. Errors default to `0`. */
  duration?: number;
}

export interface ToastItem extends ToastInput {
  id: string;
  tone: BannerTone;
}

export interface ToastApi {
  /** Shows a toast and returns its id, so a caller can dismiss it early. */
  show: (toast: ToastInput) => string;
  success: (message: ReactNode) => string;
  info: (message: ReactNode) => string;
  warning: (message: ReactNode) => string;
  /** Sticky by default. */
  error: (message: ReactNode, options?: { title?: string }) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

const DEFAULT_DURATION = 4000;

const ToastContext = createContext<ToastApi | undefined>(undefined);

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [items, setItems] = useState<ToastItem[]>([]);
  const mounted = useMounted();
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const sequence = useRef(0);

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const show = useCallback(
    (toast: ToastInput): string => {
      sequence.current += 1;
      const id = `toast-${sequence.current}`;
      const tone = toast.tone ?? 'info';
      const duration = toast.duration ?? (tone === 'error' ? 0 : DEFAULT_DURATION);

      setItems((current) => [...current, { ...toast, id, tone }]);

      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        );
      }
      return id;
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show,
      dismiss,
      success: (message) => show({ message, tone: 'success' }),
      info: (message) => show({ message, tone: 'info' }),
      warning: (message) => show({ message, tone: 'warning' }),
      error: (message, options) => show({ message, tone: 'error', title: options?.title }),
      clear: () => {
        for (const timer of timers.current.values()) clearTimeout(timer);
        timers.current.clear();
        setItems([]);
      },
    }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {mounted && items.length > 0
        ? createPortal(
            <div className={styles.viewport}>
              {items.map((item) => (
                <InlineBanner
                  key={item.id}
                  className={styles.toast}
                  tone={item.tone}
                  title={item.title}
                  onDismiss={() => dismiss(item.id)}
                >
                  {item.message}
                </InlineBanner>
              ))}
            </div>,
            document.body,
          )
        : null}
    </ToastContext.Provider>
  );
}

/**
 * Throws when no provider is above it, rather than silently doing nothing — a
 * swallowed error toast is exactly the bug this component exists to prevent.
 */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === undefined) {
    throw new Error('useToast must be used inside <ToastProvider> (mounted in app/layout.tsx)');
  }
  return api;
}
