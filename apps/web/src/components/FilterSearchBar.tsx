import { useRef } from 'react';

/**
 * Local-filter variant of the hero search bar: same pill design, but it
 * never navigates — the parent owns the value and filters its list live.
 */
export function FilterSearchBar({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Accessible name for the field. */
  label: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="search-bar filter-search-bar">
      <span className="search-bar__icon" aria-hidden="true">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
      </span>
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        spellCheck={false}
        autoComplete="off"
      />
      {value.length > 0 && (
        <button
          type="button"
          className="btn btn--ghost search-bar__clear"
          aria-label={`Clear ${label.toLowerCase()}`}
          title="Clear"
          onClick={() => {
            onChange('');
            inputRef.current?.focus();
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}
