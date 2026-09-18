import { useEffect, useRef, useState, type ReactNode } from 'react';
import { IconAlert, IconInbox } from './icons';

/**
 * Standard loading / error / empty state blocks so every screen handles
 * these consistently.
 */

const AUTO_RETRY_COUNTDOWN_SECONDS = 5;
const AUTO_RETRY_MAX_ATTEMPTS = 3;

export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
  autoRetry = true,
  maxAutoRetries = AUTO_RETRY_MAX_ATTEMPTS,
  autoRetryDelaySeconds = AUTO_RETRY_COUNTDOWN_SECONDS,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
  /**
   * When the error appears, automatically re-run `onRetry` after a 5-second
   * countdown. Capped at `maxAutoRetries` attempts; once those are spent,
   * the button becomes a plain manual "Try again". Set `autoRetry={false}`
   * to opt out (e.g. validation errors that won't get better on retry).
   */
  autoRetry?: boolean;
  maxAutoRetries?: number;
  autoRetryDelaySeconds?: number;
}) {
  const [secondsLeft, setSecondsLeft] = useState(autoRetryDelaySeconds);
  const [attempts, setAttempts] = useState(0);
  const [autoArmed, setAutoArmed] = useState(autoRetry && onRetry != null);
  const retryTimeoutRef = useRef<number | undefined>(undefined);
  const tickIntervalRef = useRef<number | undefined>(undefined);

  /**
   * Tick the visible countdown every second; fire the auto-retry exactly
   * once when the timer hits zero. The auto-retry must NOT be conditional
   * on `attempts < maxAutoRetries` inside the timeout — we set `autoArmed`
   * to false on user click to cancel, and the cap is enforced by re-arming
   * the next countdown only if the previous attempt still counts.
   */
  useEffect(() => {
    if (!autoArmed || !onRetry) return;
    if (attempts >= maxAutoRetries) {
      setAutoArmed(false);
      return;
    }
    setSecondsLeft(autoRetryDelaySeconds);
    tickIntervalRef.current = window.setInterval(() => {
      setSecondsLeft((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    retryTimeoutRef.current = window.setTimeout(() => {
      if (tickIntervalRef.current !== undefined) {
        window.clearInterval(tickIntervalRef.current);
        tickIntervalRef.current = undefined;
      }
      setAttempts((a) => a + 1);
      onRetry();
    }, autoRetryDelaySeconds * 1000);
    return () => {
      if (tickIntervalRef.current !== undefined) {
        window.clearInterval(tickIntervalRef.current);
        tickIntervalRef.current = undefined;
      }
      if (retryTimeoutRef.current !== undefined) {
        window.clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = undefined;
      }
    };
  }, [autoArmed, attempts, maxAutoRetries, autoRetryDelaySeconds, onRetry]);

  const handleClick = () => {
    // Cancel any pending auto-retry so the user-driven click doesn't get
    // double-fired at the end of the countdown.
    if (tickIntervalRef.current !== undefined) {
      window.clearInterval(tickIntervalRef.current);
      tickIntervalRef.current = undefined;
    }
    if (retryTimeoutRef.current !== undefined) {
      window.clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = undefined;
    }
    if (onRetry) {
      setAttempts((a) => a + 1);
      onRetry();
    }
  };

  const showCountdown = autoArmed && attempts < maxAutoRetries;

  return (
    <div className="state-view" role="alert">
      <div className="state-view__icon state-view__icon--error" aria-hidden="true">
        <IconAlert size={28} />
      </div>
      <h2 className="state-view__title">{title}</h2>
      {message && <p className="state-view__label">{message}</p>}
      {onRetry && (
        <button
          type="button"
          className="btn btn--primary"
          onClick={handleClick}
          aria-label={
            showCountdown
              ? `Try again — auto-retry in ${secondsLeft} second${secondsLeft === 1 ? '' : 's'}`
              : 'Try again'
          }
        >
          {showCountdown ? `Try again (${secondsLeft})` : 'Try again'}
        </button>
      )}
      {showCountdown && (
        <p className="state-view__hint" aria-live="polite">
          Auto-retry {attempts + 1} of {maxAutoRetries}
        </p>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  message,
  action,
}: {
  title: string;
  message?: string;
  action?: ReactNode;
}) {
  return (
    <div className="state-view">
      <div className="state-view__icon" aria-hidden="true">
        <IconInbox size={28} />
      </div>
      <h2 className="state-view__title">{title}</h2>
      {message && <p className="state-view__label">{message}</p>}
      {action}
    </div>
  );
}
