import { IconCheck } from './icons';

interface ChapterSelectCheckboxProps {
  checked: boolean;
  onChange: () => void;
  chapterTitle: string;
}

/**
 * Per-row selection checkbox for chapter multi-select. Renders as an
 * icon-only square that fills with the accent color and a white tick when
 * checked. Click events stop propagation so toggling selection doesn't
 * bubble up to the row's `Link` (which would otherwise navigate to the
 * reader).
 *
 * Visually mirrors `ChapterDownloadButton` so the row's hover-revealed
 * actions line up.
 */
export function ChapterSelectCheckbox({
  checked,
  onChange,
  chapterTitle,
}: ChapterSelectCheckboxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={checked ? `Deselect ${chapterTitle}` : `Select ${chapterTitle}`}
      title={checked ? 'Deselect' : 'Select'}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        onChange();
      }}
      className={`chapter-select-checkbox${checked ? ' chapter-select-checkbox--checked' : ''}`}
    >
      <span aria-hidden="true" className="chapter-select-checkbox__icon">
        {checked ? <IconCheck size={14} /> : null}
      </span>
    </button>
  );
}