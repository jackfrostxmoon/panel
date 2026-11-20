import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { SearchMode } from '@panel/shared';
import { useResolvePanelUrl } from '../api/hooks';
import { useToast } from './Toast';
import {
  clearSearchHistory,
  loadSearchHistory,
  removeSearchHistoryEntry,
  recordSearchQuery,
  saveSearchHistory,
  type SearchHistoryEntry,
} from '../utils/searchHistory';

/** A search input value that is a link to a supported source page. */
function asPanelUrl(value: string): string | null {
  const trimmed = value.trim();
  return /^https?:\/\/\S+$/i.test(trimmed) ? trimmed : null;
}

/**
 * `/search` query string for a submit: the term, plus the toolbar's source
 * and credit mode when known. Omitting `mode` for title searches keeps the
 * URL clean (the search page defaults to title mode).
 */
function searchQueryString(query: string, source?: string, mode: SearchMode = 'title'): string {
  const params = new URLSearchParams({ q: query });
  if (source) params.set('source', source);
  if (mode !== 'title') params.set('mode', mode);
  return params.toString();
}

const PLACEHOLDER_PHRASES = [
  'Search titles or paste a series URL…',
  'Try “Solo Leveling”…',
  'Try “Berserk”…',
  'Paste a series link to open it directly…',
] as const;

/**
 * Typewriter-cycled placeholder for the idle (empty) field.
 * Pauses to the static default phrase while typed into. When the OS requests
 * reduced motion (e.g. Windows "best performance" mode), the typewriter is
 * replaced by quiet whole-phrase swaps with a gentle CSS crossfade.
 */
function useTypewriterPlaceholder(active: boolean, onCycle?: () => void): string {
  const [text, setText] = useState<string>(PLACEHOLDER_PHRASES[0]);

  useEffect(() => {
    if (!active) {
      setText(PLACEHOLDER_PHRASES[0]);
      return;
    }

    // Reduced motion: swap full phrases on a gentle cadence instead of typing.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      let index = 0;
      let timer = 0;
      const next = () => {
        index = (index + 1) % PLACEHOLDER_PHRASES.length;
        setText(PLACEHOLDER_PHRASES[index] ?? PLACEHOLDER_PHRASES[0]);
        onCycle?.();
        timer = window.setTimeout(next, 3000);
      };
      timer = window.setTimeout(next, 3000);
      return () => window.clearTimeout(timer);
    }

    let phrase = 0;
    let char = PLACEHOLDER_PHRASES[0].length;
    let deleting = false;
    let timer = 0;

    const tick = () => {
      const current: string = PLACEHOLDER_PHRASES[phrase] ?? PLACEHOLDER_PHRASES[0];
      if (!deleting) {
        if (char >= current.length) {
          // Full phrase visible — hold, then start deleting.
          deleting = true;
          timer = window.setTimeout(tick, 1500);
          return;
        }
        char += 1;
        setText(current.slice(0, char));
        timer = window.setTimeout(tick, 85);
      } else {
        char -= 1;
        setText(current.slice(0, char));
        if (char === 0) {
          deleting = false;
          phrase = (phrase + 1) % PLACEHOLDER_PHRASES.length;
          timer = window.setTimeout(tick, 600);
        } else {
          timer = window.setTimeout(tick, 45);
        }
      }
    };

    timer = window.setTimeout(tick, 500);
    return () => window.clearTimeout(timer);
  }, [active, onCycle]);

  return text;
}

/**
 * Debounced search input. On the home page it navigates to /search?q=…;
 * on the search page it stays controlled by the current query param.
 * Pasting a source url (e.g. https://hiperdex.com/manga/<slug>) opens that
 * series directly instead of searching.
 * Pressing "/" anywhere focuses the field; the hint chip hides while typing.
 *
 * `source` / `mode` carry the toolbar's current adapter and search mode into
 * the /search navigation so resubmitting from the search or latest page
 * stays on that source (and credit mode) instead of snapping back to the
 * default source.
 */
export function SearchBar({
  initialValue = '',
  autoFocus = false,
  large = false,
  showPasteButton = false,
  source,
  mode = 'title',
}: {
  initialValue?: string;
  autoFocus?: boolean;
  large?: boolean;
  /** Show a one-tap clipboard-paste button (used by the home hero). */
  showPasteButton?: boolean;
  /** Active listing source to keep when the form submits. */
  source?: string;
  /** Active search mode to keep (author/artist stay selected on resubmit). */
  mode?: SearchMode;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const resolveUrl = useResolvePanelUrl();
  const { toast } = useToast();
  // Animates whenever the field is empty — focused or not. Typing stops it.
  /** Replays the one-shot placeholder fade so whole-phrase swaps ease in. */
  const restartPlaceholderFade = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    input.classList.remove('search-bar__input--ph-fade');
    void input.offsetWidth; // force reflow so the animation can replay
    input.classList.add('search-bar__input--ph-fade');
  }, []);
  const placeholder = useTypewriterPlaceholder(!value, restartPlaceholderFade);

  useEffect(() => setValue(initialValue), [initialValue]);

  /** Search history (T1-4): persisted locally, surfaced as a dropdown. */
  const [history, setHistory] = useState<SearchHistoryEntry[]>(() => loadSearchHistory());
  const [historyOpen, setHistoryOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Close the dropdown on click outside / Escape.
  useEffect(() => {
    if (!historyOpen) return;
    const onClick = (event: MouseEvent) => {
      if (wrapperRef.current?.contains(event.target as Node)) return;
      setHistoryOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHistoryOpen(false);
    };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [historyOpen]);

  // "/" focuses the search field from anywhere on the page (unless the user
  // is already typing in another field).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== '/' ||
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target as HTMLElement | null;
      const isTypingTarget =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);
      if (isTypingTarget) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  /** Run a search for a raw query string — shared by form submit and
      history-item taps so both behave identically (record, resolve URLs,
      navigate). */
  const runQuery = useCallback(
    async (raw: string) => {
      const query = raw.trim();
      if (query.length === 0 || resolveUrl.isPending) return;

      // Record the query in history (T1-4) before navigating.
      if (!asPanelUrl(query)) {
        const next = recordSearchQuery(query, history);
        setHistory(next);
        saveSearchHistory(next);
      }

      const url = asPanelUrl(query);
      if (url) {
        try {
          const { panelId } = await resolveUrl.mutateAsync(url);
          navigate(`/panel/${encodeURIComponent(panelId)}`);
          setValue('');
          setHistoryOpen(false);
          return;
        } catch {
          toast('That link is not from a supported panel site.', 'error');
          return;
        }
      }

      navigate(`/search?${searchQueryString(query, source, mode)}`);
      setHistoryOpen(false);
    },
    [history, navigate, resolveUrl, toast, source, mode],
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void runQuery(value);
  };

  const isUrl = asPanelUrl(value) !== null;

  /** One-tap clipboard paste: fills the field, then Search/Enter takes over. */
  const canPaste =
    showPasteButton && typeof navigator !== 'undefined' && Boolean(navigator.clipboard?.readText);

  const pasteFromClipboard = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) {
        toast('Clipboard is empty.', 'info');
        return;
      }
      setValue(text);
      inputRef.current?.focus();
      inputRef.current?.select();
    } catch {
      toast('Clipboard access was blocked by the browser.', 'error');
    }
  };

  return (
    <div
      className="search-bar__wrapper"
      ref={wrapperRef}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && historyOpen) {
          setHistoryOpen(false);
          inputRef.current?.blur();
        }
      }}
    >
      <form
        role="search"
        className={`search-bar${large ? ' search-bar--large' : ''}`}
        onSubmit={submit}
        onFocus={() => {
          if (history.length > 0) setHistoryOpen(true);
        }}
      >
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
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        aria-label="Search panel titles or paste a series URL"
        spellCheck={false}
        autoComplete="off"
        autoFocus={autoFocus}
        enterKeyHint="search"
      />
      <kbd className="search-bar__kbd" aria-hidden="true">
        /
      </kbd>
      {value.length > 0 ? (
        <button
          type="button"
          className="btn btn--ghost search-bar__clear"
          aria-label="Clear search"
          title="Clear search"
          onClick={() => {
            setValue('');
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
      ) : (
        canPaste && (
          <button
            type="button"
            className="btn btn--ghost search-bar__paste"
            aria-label="Paste from clipboard"
            title="Paste from clipboard"
            onClick={pasteFromClipboard}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
            </svg>
          </button>
        )
      )}
      <button
        type="submit"
        className="btn btn--primary search-bar__submit"
        disabled={resolveUrl.isPending}
      >
        {resolveUrl.isPending && isUrl ? 'Opening…' : 'Search'}
      </button>
    </form>

    {/* Search-history dropdown (T1-4) — recent searches, one-tap retry. */}
    {historyOpen && history.length > 0 && (
      <div
        className="search-bar__history"
        role="listbox"
        aria-label="Recent searches"
      >
        <div className="search-bar__history__header">
          <span>Recent searches</span>
          <button
            type="button"
            className="btn btn--ghost btn--sm search-bar__history__clear"
            aria-label="Clear all search history"
            title="Clear all search history"
            onClick={() => {
              const next = clearSearchHistory();
              setHistory(next);
              saveSearchHistory(next);
            }}
          >
            Clear all
          </button>
        </div>
        <ul>
          {history.map((entry) => (
            <li key={entry.at + entry.query}>
              <button
                type="button"
                className="search-bar__history__item"
                onClick={() => {
                  setValue(entry.query);
                  void runQuery(entry.query);
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
                  className="search-bar__history__clock"
                >
                  <circle cx="12" cy="12" r="9" />
                  <polyline points="12 7 12 12 15 14" />
                </svg>
                <span className="search-bar__history__query">{entry.query}</span>
                <span
                  className="search-bar__history__remove"
                  aria-label={`Remove "${entry.query}" from history`}
                  title="Remove from history"
                  onClick={(e) => {
                    e.stopPropagation();
                    const next = removeSearchHistoryEntry(entry.query, history);
                    setHistory(next);
                    saveSearchHistory(next);
                  }}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    )}
    </div>
  );
}
