import { useState, useRef, useEffect } from 'react';
import { useClearPanelRating, useSetPanelRating } from '../api/hooks';
import { useToast } from './Toast';
import { IconStar } from './icons';
import { useIncognito } from '../hooks/useIncognito';

/**
 * 1–5 star rating control (T3-3). Click a star to rate; clicking the active
 * rating again clears it. Optimistic via the mutation's cache write.
 *
 * Collapsed by default so the details toolbar stays compact: it renders a
 * single star face (gold when the panel is rated, faint otherwise) next to
 * the current value. Clicking/tapping the face — or focusing it — expands
 * the full 5-star radiogroup in place. It is intentionally click-driven
 * rather than hover-driven: hover expansion flickered when the pointer sat
 * near the segment edge. The full face collapses after a selection, on
 * Escape, or when a pointer-down lands outside the widget. The face and the
 * full radiogroup are stacked in one animated-width container, and the
 * stars are removed from the tab order while collapsed.
 */
export function StarRating({ panelId, rating }: { panelId: string; rating: number | null | undefined }) {
  const setRating = useSetPanelRating();
  const clearRating = useClearPanelRating();
  const { toast } = useToast();
  /** Star the pointer is hovering (null = not hovering). */
  const [hover, setHover] = useState<number | null>(null);
  /** Expand state, tracked per trigger so they don't fight each other. */
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const expanded = focused || pinned;
  const shown = hover ?? rating ?? 0;
  /** Used to return focus to the face button when the widget collapses via Escape. */
  const faceRef = useRef<HTMLButtonElement>(null);
  /** Root element, used to collapse the pinned face when a pointer-down lands outside. */
  const rootRef = useRef<HTMLDivElement>(null);
  // Incognito: ratings are hidden with the other user-data controls.
  const { enabled: incognito } = useIncognito();

  const handlePick = (value: number) => {
    // Collapse back to the compact face after a selection so the toolbar
    // settles.
    setPinned(false);
    if (value === rating) {
      clearRating.mutate(panelId, {
        onSuccess: () => toast('Rating removed'),
        onError: (error) => toast(error.message, 'error'),
      });
      return;
    }
    setRating.mutate(
      { panelId, rating: value },
      {
        onSuccess: () => toast(`Rated ${value} of 5`, 'success'),
        onError: (error) => toast(error.message, 'error'),
      },
    );
  };

  const handleBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    // Collapse only when focus leaves the whole widget (not when it moves
    // between the face and the stars).
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setFocused(false);
  };

  // Collapse a pinned (click-to-open) widget when a pointer-down lands
  // outside it — there is no hover-leave to trigger the collapse anymore.
  useEffect(() => {
    if (!pinned) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setPinned(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [pinned]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    setPinned(false);
    setFocused(false);
    faceRef.current?.focus();
  };

  // Incognito: ratings are hidden entirely.
  if (incognito) return null;

  return (
    <div
      ref={rootRef}
      className={`star-rating${expanded ? ' star-rating--expanded' : ''}`}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={handleBlur}
      onKeyDown={handleKeyDown}
    >
      {/* Collapsed face — a single star + value. Expands on click/tap
          (pinned), or via keyboard focus. */}
      <button
        type="button"
        ref={faceRef}
        className="star-rating__face"
        aria-label={rating ? `Your rating: ${rating} of 5. Activate to change it` : 'Rate this title'}
        aria-expanded={expanded}
        tabIndex={expanded ? -1 : 0}
        onClick={() => setPinned((value) => !value)}
      >
        <IconStar size={18} filled={shown > 0} className={shown > 0 ? 'star-rating__face-star--active' : undefined} />
        {rating ? <span className="star-rating__face-value">{rating}</span> : null}
      </button>

      {/* Full face — the actual 5-star radiogroup. In the tab order only
          while expanded. */}
      <div
        className="star-rating__full"
        role="radiogroup"
        aria-label="Your rating"
        aria-hidden={expanded ? undefined : true}
        onMouseLeave={() => setHover(null)}
      >
        {[1, 2, 3, 4, 5].map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={rating === value}
            aria-label={`Rate ${value} of 5`}
            className={`star-rating__star${value <= shown ? ' star-rating__star--active' : ''}`}
            disabled={setRating.isPending || clearRating.isPending}
            tabIndex={expanded ? 0 : -1}
            onMouseEnter={() => setHover(value)}
            onFocus={() => setHover(value)}
            onBlur={() => setHover(null)}
            onClick={() => handlePick(value)}
          >
            <IconStar size={20} filled={value <= shown} />
          </button>
        ))}
        {rating ? <span className="star-rating__value">{rating}/5</span> : null}
      </div>
    </div>
  );
}
