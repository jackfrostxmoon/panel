import { useEffect, useState } from 'react';

/**
 * Only reports `true` after `delayMs` has elapsed while `loading` stays true.
 *
 * This prevents skeleton screens and progress bars from flickering on
 * fast / cached responses — a request that resolves in < 200 ms never
 * flashes a loading placeholder to the user.
 *
 * Usage:
 *   const showLoading = useDelayedLoading(query.isLoading);
 */
export function useDelayedLoading(loading: boolean, delayMs = 250): boolean {
  const [delayed, setDelayed] = useState(false);

  useEffect(() => {
    if (!loading) {
      setDelayed(false);
      return;
    }
    const id = setTimeout(() => setDelayed(true), delayMs);
    return () => clearTimeout(id);
  }, [loading, delayMs]);

  return delayed;
}
