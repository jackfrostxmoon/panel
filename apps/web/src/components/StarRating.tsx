import { useState, useRef } from 'react';
import { useClearPanelRating, useSetPanelRating } from '../api/hooks';
import { useToast } from './Toast';
import { IconStar } from './icons';

/**
 * 1–5 star rating control (T3-3). Click a star to rate; clicking the active
 * rating again clears it. Optimistic via the mutation's cache write.
 *
 * Collapsed by default so the details toolbar stays compact: it renders a
 * single star face (gold when the panel is rated, faint otherwise) next to
 * the current value. Hovering or focusing the segment — or tapping/clicking
 * the face — expands the full 5-star radiogroup in place; it collapses back
 * when the pointer/focus leaves, after a selection, or on Escape. The face
 * and the full radiogroup are stacked in one animated-width container, and
 * the stars are removed from the tab order while collapsed.
 */
export function StarRating({ panelId, rating }: { panelId: string; rating: number | null | undefined }) {
  const setRating = useSetPanelRating();
  const clearRating = useClearPanelRating();
  const { toast } = useToast();
  /** Star the pointer is hovering (null = not hovering). */
  const [hover, setHover] = useState<number | null>(null);
  /** Expand state, tracked per trigger so they don't fight each other. */
  const [hovering, setHovering] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const expanded = hovering || focused || pinned;
  const shown = hover ?? rating ?? 0;
  /** Used to return focus to the face button when the widget collapses via Escape. */
  const faceRef = useRef<HTMLButtonElement>(null);

  const handlePick = (value: number) => {
    // Keep the collapsed/expanded state stable for the common case (the
    // full face collapses once the pointer leaves); on touch we collapse
    // after a selection so the toolbar settles.
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

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    setPinned(false);
    setHovering(false);
    setFocused(false);
    faceRef.current?.focus();
  };

  return (
    <div
      className={`star-rating${expanded ? ' star-rating--expanded' : ''}`}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={handleBlur}
      onKeyDown={handleKeyDown}
    >
      {/* Collapsed face — a single star + value. Expands on click/tap
          (pinned), or via the hover/focus paths shared with the full face. */}
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
