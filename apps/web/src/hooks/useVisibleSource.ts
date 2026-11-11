import { useEffect, useMemo } from 'react';
import type { SetURLSearchParams } from 'react-router-dom';
import { useSourceOrder } from '../api/hooks';
import { defaultSourceFor, effectiveHiddenSources } from '../utils/format';

/**
 * Effective listing source honoring order + visibility.
 *
 * - No `?source=` param → the default (first visible source in the user's
 *   order, MangaKatana until an order is saved).
 * - `?source=` naming a hidden source (deep link, or a toggle flipped
 *   mid-visit) → the default, plus a replace-navigation rewriting the URL
 *   so pills, pagination, and keyboard nav stay on the source actually
 *   queried. The effect only fires for hidden sources, so it can never
 *   fight pill-tap navigations (pills only offer visible sources).
 */
export function useVisibleSource(
  params: URLSearchParams,
  setParams: SetURLSearchParams,
): string {
  const sourceOrder = useSourceOrder();
  const hidden = useMemo(
    () => effectiveHiddenSources(sourceOrder.data?.hidden),
    [sourceOrder.data?.hidden],
  );
  const requested = params.get('source');
  const fallback = defaultSourceFor(sourceOrder.data?.order, sourceOrder.data?.hidden);
  const remapped = requested !== null && hidden.has(requested);

  useEffect(() => {
    if (!remapped) return;
    const next = new URLSearchParams(params);
    next.set('source', fallback);
    next.delete('page');
    // Same per-source genre reset as a pill-tap source switch — a stale
    // genre from the hidden source must not leak onto the default one.
    next.delete('genre');
    setParams(next, { replace: true });
  }, [remapped, fallback, params, setParams]);

  if (requested === null || remapped) return fallback;
  return requested;
}
