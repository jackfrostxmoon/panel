import { useEffect, useRef, useState } from 'react';

/**
 * Multi-select genre picker: a pill button (matching the filter-select
 * look) that opens a checkbox popup. Used for the include-genre and
 * exclude-genre filters on the Latest, Search and Bookmarks pages. The
 * component just reports the checked labels; the consumer decides whether
 * include means "any match" (OR) or "all match" (AND).
 *
 * Closes on outside click / Escape; fully keyboard-operable through the
 * native button + checkbox inputs.
 */
export function GenreMultiSelect({
  label,
  options,
  selected,
  onChange,
  emptyLabel,
  pluralLabel,
}: {
  /** Accessible name for the group, e.g. "Filter by genre". */
  label: string;
  /** All available labels (site order or alphabetical). */
  options: readonly string[];
  /** Currently selected labels. */
  selected: readonly string[];
  onChange: (next: string[]) => void;
  /** Button text when nothing is selected, e.g. "Any genre". */
  emptyLabel: string;
  /** Button text base when selected, e.g. "Genres" → "Genres (2)". */
  pluralLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open ]);

  function toggle(option: string) {
    onChange(
      selected.includes(option)
        ? selected.filter((s) => s !== option)
        : [...selected, option],
    );
  }

  const active = selected.length > 0;
  /**
   * Selected labels are always listed, even when `options` no longer
   * contains them: a filter combination that returns nothing can leave the
   * option source empty, and a checkbox you cannot see is a checkbox you
   * cannot uncheck (the bulk Clear would be the only escape).
   */
  const listed = [...options];
  for (const option of selected) {
    if (!listed.includes(option)) listed.push(option);
  }
  return (
    <span className="genre-multi" ref={rootRef}>
      <button
        type="button"
        className={'genre-multi__button' + (active ? ' genre-multi__button--active' : '')}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="genre-multi__button-text">
          {active ? `${pluralLabel} (${selected.length})` : emptyLabel}
        </span>
        <svg
          className="genre-multi__caret"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <polyline
            points="6 9 12 15 18 9"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <span
          className="genre-multi__popup"
          role="group"
          aria-label={label}
        >
          {listed.length === 0 && (
            <span className="genre-multi__empty">No genres to choose from.</span>
          )}
          {listed.map((option) => (
            <label key={option} className="genre-multi__option">
              <input
                type="checkbox"
                checked={selected.includes(option)}
                onChange={() => toggle(option)}
              />
              <span className="genre-multi__option-label">{option}</span>
            </label>
          ))}
          {active && (
            <button
              type="button"
              className="genre-multi__clear"
              onClick={() => {
                onChange([]);
                setOpen(false);
              }}
            >
              Clear
            </button>
          )}
        </span>
      )}
    </span>
  );
}
