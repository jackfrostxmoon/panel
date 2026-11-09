import { useState } from 'react';
import { useClearPanelRating, useSetPanelRating } from '../api/hooks';
import { useToast } from './Toast';
import { IconStar } from './icons';

/**
 * 1–5 star rating control (T3-3). Click a star to rate; clicking the active
 * rating again clears it. Optimistic via the mutation's cache write.
 */
export function StarRating({ panelId, rating }: { panelId: string; rating: number | null | undefined }) {
  const setRating = useSetPanelRating();
  const clearRating = useClearPanelRating();
  const { toast } = useToast();
  /** Star the pointer is hovering (null = not hovering). */
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? rating ?? 0;

  const handlePick = (value: number) => {
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

  return (
    <div
      className="star-rating"
      role="radiogroup"
      aria-label="Your rating"
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
  );
}