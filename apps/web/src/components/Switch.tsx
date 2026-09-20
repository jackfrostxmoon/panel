/**
 * Polished on/off switch used for boolean settings. Extracted from the
 * inline `Switch` in `ReaderSettingsPanel.tsx` so the reader settings
 * panel and the new display toggle (Cache Settings → Display) reuse the
 * same accessible markup.
 *
 * Rendered as a `<button role="switch">` so it stays keyboard-focusable
 * and announces its state to screen readers; the thumb is a pure
 * decorative `<span>` (no aria needed — the button's `aria-checked`
 * carries the semantics).
 */
export function Switch({
  checked,
  onChange,
  labelledBy,
  size,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The id of the element that labels this switch (for aria-labelledby). */
  labelledBy: string;
  /** Compact variant for inline toolbar placement (defaults to regular). */
  size?: 'sm';
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      className={`switch${checked ? ' switch--on' : ''}${size === 'sm' ? ' switch--sm' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch__thumb" />
    </button>
  );
}