import type { SearchMode } from '@panel/shared';

/**
 * Title / Author / Artist segmented control for the search toolbar.
 * Mirrors the Cards/List `layout-toggle` visual language; state lives in the
 * page's URL (`?mode=`), not in persisted settings.
 */
export function SearchModeToggle({
  mode,
  onChange,
  labelId,
}: {
  mode: SearchMode;
  onChange: (next: SearchMode) => void;
  /** Id of the visible label for aria-labelledby. */
  labelId: string;
}) {
  const options: Array<{ value: SearchMode; label: string; title: string }> = [
    { value: 'title', label: 'Title', title: 'Search titles' },
    { value: 'author', label: 'Author', title: 'Search by author name' },
    { value: 'artist', label: 'Artist', title: 'Search by artist name' },
  ];
  return (
    <span className="search-filters__switch search-filters__switch--mode">
      <span className="search-filters__label" id={labelId}>
        Search by
      </span>
      <span className="layout-toggle" role="group" aria-labelledby={labelId}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`layout-toggle__btn${mode === option.value ? ' layout-toggle__btn--active' : ''}`}
            aria-pressed={mode === option.value}
            title={option.title}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </span>
    </span>
  );
}
