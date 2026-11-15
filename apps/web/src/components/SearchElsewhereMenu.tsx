import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { IconSearch } from './icons';

interface SearchElsewhereMenuProps {
  /** The panel's display title — always the first (plain title-mode) row. */
  title: string;
  /** Alternative titles from the source — title-mode search rows. */
  altTitles: string[];
  /** Authors — credit-mode (`mode=author`) search rows. */
  authors: string[];
  /** Artists — credit-mode (`mode=artist`) search rows. */
  artists: string[];
}

interface MenuSection {
  label: string;
  items: Array<{ text: string; to: string }>;
}

const searchHref = (q: string, mode?: 'author' | 'artist') =>
  `/search?q=${encodeURIComponent(q)}${mode ? `&mode=${mode}` : ''}`;

/** Trim + drop empties + dedupe (case-insensitive). */
const unique = (values: string[]) => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const text = value.trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
};

/**
 * Build `/search` deep-links for every way this panel can be found on other
 * sources: its own title, its alternative titles, and its credits (author /
 * artist searches run in the search page's credit mode). Sections with no
 * rows are omitted entirely.
 */
function buildSections({ title, altTitles, authors, artists }: SearchElsewhereMenuProps): MenuSection[] {
  const sections: MenuSection[] = [];
  const cleanTitle = title.trim();
  if (cleanTitle) {
    sections.push({ label: 'Title', items: [{ text: cleanTitle, to: searchHref(cleanTitle) }] });
  }
  const aliases = unique(altTitles).filter((a) => a.toLowerCase() !== cleanTitle.toLowerCase());
  if (aliases.length > 0) {
    sections.push({ label: 'Aliases', items: aliases.map((text) => ({ text, to: searchHref(text) })) });
  }
  const cleanAuthors = unique(authors);
  if (cleanAuthors.length > 0) {
    sections.push({ label: 'Author', items: cleanAuthors.map((text) => ({ text, to: searchHref(text, 'author') })) });
  }
  const cleanArtists = unique(artists);
  if (cleanArtists.length > 0) {
    sections.push({ label: 'Artist', items: cleanArtists.map((text) => ({ text, to: searchHref(text, 'artist') })) });
  }
  return sections;
}

/**
 * Magnifying-glass button rendered next to the details-page title. Opens a
 * dropdown listing every name this panel goes by elsewhere — the title, its
 * alternative titles, and its author/artist credits — each row deep-linking
 * into the search page pre-filled with that query so the user can check
 * whether another source carries the same work.
 *
 * Closes on outside pointerdown or Escape; Escape returns focus to the
 * trigger. Anchored right of the trigger so it can never clip off-screen.
 */
export function SearchElsewhereMenu({ title, altTitles, authors, artists }: SearchElsewhereMenuProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Outside pointerdown closes the menu (same shape as BookmarkFolderSelector);
  // Escape closes and hands focus back to the trigger.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (event.isPrimary === false) return;
      const target = event.target as Node | null;
      if (target && rootRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const sections = buildSections({ title, altTitles, authors, artists });
  const go = (to: string) => {
    setOpen(false);
    triggerRef.current?.focus();
    navigate(to);
  };

  return (
    <div className="search-elsewhere" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="panel-details__search"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="search-elsewhere-menu"
        aria-label="Search this title on other sources"
        title="Search this title on other sources"
      >
        <IconSearch size={18} />
      </button>
      {open && (
        <div
          className="search-elsewhere__menu"
          id="search-elsewhere-menu"
          role="menu"
          aria-label="Search this title on other sources"
        >
          {sections.map((section) => (
            <div className="search-elsewhere__group" role="group" aria-label={section.label} key={section.label}>
              <span className="search-elsewhere__label">{section.label}</span>
              {section.items.map((item, index) => (
                <button
                  key={`${section.label}:${index}`}
                  type="button"
                  role="menuitem"
                  className="search-elsewhere__item"
                  title={item.text}
                  onClick={() => go(item.to)}
                >
                  {item.text}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
