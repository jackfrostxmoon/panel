/**
 * Small text normalizers for source-provided labels. Sources are messy:
 * genre names arrive with trailing commas ("Action ,"), stray whitespace,
 * and case variants ("action" vs "Action") — sometimes all three on the
 * same site. Centralized here so catalogs, detail genres, and matching
 * all treat the same label the same way.
 */

/**
 * Canonical display form of one genre label: collapse inner whitespace,
 * drop trailing separators. Interior punctuation ("Training & Growth",
 * "Shounen-ai / BL (Subtle)") is preserved — only the junk some sites
 * append is stripped.
 */
export function cleanGenreLabel(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/\s+/g, ' ')
    .replace(/[\s,;]+$/u, '')
    .trim();
}

/**
 * Clean + case-insensitive dedupe, keeping the first-seen display form
 * and the site order. Used for filter-dropdown catalogs so "action" /
 * "Action" / "Action ," collapse to a single row.
 */
export function dedupeGenreLabels(labels: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of labels) {
    const label = cleanGenreLabel(raw);
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}
