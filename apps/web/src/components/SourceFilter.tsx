import { SOURCE_OPTIONS } from '../utils/format';

interface SourceFilterProps {
  value: string;
  onChange: (source: string) => void;
  /**
   * Show an "All" entry. Only for purely local filters (e.g. bookmarks) —
   * upstream queries must always target exactly one source so the fan-out
   * to every site at once can't look like bot traffic.
   */
  allowAll?: boolean;
}

/**
 * Segmented control choosing which source to query. Options are derived from
 * SOURCE_OPTIONS so new adapters appear here automatically once their label
 * is registered.
 */
export function SourceFilter({ value, onChange, allowAll = false }: SourceFilterProps) {
  const button = (code: string, label: string) => (
    <button
      key={code || 'all'}
      type="button"
      className={`source-filter__btn${value === code ? ' source-filter__btn--active' : ''}`}
      aria-pressed={value === code}
      onClick={() => onChange(code)}
    >
      {label}
    </button>
  );

  return (
    <div className="source-filter" role="group" aria-label="Filter by source">
      {allowAll && button('', 'All')}
      {SOURCE_OPTIONS.map(({ code, label }) => button(code, label))}
    </div>
  );
}
