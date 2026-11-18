import { Link } from 'react-router-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Chapter } from '@panel/shared';
import { formatDate } from '../utils/format';
import { chapterMarker } from '../utils/chapterMarkers';
import { compareChaptersAscending } from '../reader/navigation';
import { ChapterBookmarkButton } from './ChapterBookmarkButton';
import { ChapterDownloadButton } from './ChapterDownloadButton';
import { ChapterSelectCheckbox } from './ChapterSelectCheckbox';

const LONG_PRESS_MS = 350;
const LONG_PRESS_MOVE_PX = 10;

/**
 * Chapter list for the details page. Simple flat list view,
 * shows progress indicators for chapters with saved readings.
 * Batch actions live in the page's section controls, not here.
 *
 * Long-press (T2-3): holding a chapter row opens a quick-action menu with
 * bookmark / mark read / go-to actions. A tap still navigates normally.
 */
export function ChapterList({
  chapters,
  readChapterIds,
  bookmarkedChapterIds,
  panelId,
  sortOrder = 'newest',
  onChapterClick,
  onKeyDown,
  onChapterAction,
  onReadChapter,
  /** Per-chapter download state + actions, owned by the parent (the
       panel-details page) so the same downloader drives both the row
       button and the bulk "Download all" panel without duplicating state. */
  downloader,
  /** True when the row checkboxes are shown (multi-select mode). */
  selectionMode = false,
  /** Currently-selected chapter ids (empty when `selectionMode` is false). */
  selectedIds,
  /** Toggle a chapter in/out of the selection set. */
  onToggleSelected,
}: {
  chapters: Chapter[];
  readChapterIds?: Set<string>;
  bookmarkedChapterIds?: Set<string>;
  panelId?: string;
  sortOrder?: 'newest' | 'oldest';
  onChapterClick?: (chapterId: string) => void;
  onKeyDown?: (e: React.KeyboardEvent, chapterId: string) => void;
  onChapterAction?: (action: 'read' | 'unread' | 'bookmark' | 'unbookmark', chapter: Chapter) => void;
  /** Open the reader for the given chapter. Wired by the parent to its
      router so navigation stays a page responsibility. */
  onReadChapter?: (chapterId: string) => void;
  downloader?: {
    /** True while this chapter is actively downloading. */
    isActive: (chapterId: string) => boolean;
    /** True when this chapter finished successfully in this session. */
    isDone: (chapterId: string) => boolean;
    /** True when the last run was cancelled. */
    isCancelled: (chapterId: string) => boolean;
    /** True when the last run errored. */
    isFailed: (chapterId: string) => boolean;
    /** "X / Y" pages for the running chapter (or null when idle). */
    progressLabel: (chapterId: string) => string | null;
    /** Fire-and-forget; resolves once the chapter finishes. */
    startOne: (chapter: Chapter) => void;
    /** Cancel this chapter if it's running (no-op otherwise). */
    cancelOne: () => void;
  };
  selectionMode?: boolean;
  selectedIds?: Set<string>;
  onToggleSelected?: (chapterId: string) => void;
}) {
  // Sort chapters by the global sort order — same key everywhere so the
  // visible order matches reader navigation (partially-numbered panels included).
  const sortedChapters = [...chapters].sort((a, b) =>
    sortOrder === 'newest'
      ? compareChaptersAscending(b, a)
      : compareChaptersAscending(a, b),
  );

  // Long-press menu state — global so the menu is a single portal above the list.
  const [menu, setMenu] = useState<{ chapter: Chapter } | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [longPressingId, setLongPressingId] = useState<string | null>(null);
  const pressStartRef = useRef<{ x: number; y: number; id: string } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Timestamp until which the next row click is swallowed (set on long-press). */
  const suppressClickUntilRef = useRef(0);

  const clearPress = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pressStartRef.current = null;
    setLongPressingId(null);
  }, []);

  useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener('scroll', close, { passive: true });
    window.addEventListener('resize', close, { passive: true });
    window.addEventListener('contextmenu', close);
    return () => {
      window.removeEventListener('scroll', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('contextmenu', close);
    };
  }, []);

  const handleClick = useCallback(
    (chapter: Chapter, e: React.MouseEvent) => {
      // Don't navigate if the click originated from the bookmark button
      const target = e.target as HTMLElement;
      if (
        target.closest('.chapter-bookmark-btn') ||
        target.closest('.chapter-download-btn') ||
        target.closest('.chapter-select-checkbox') ||
        target.closest('[data-bookmark-action]')
      ) {
        e.preventDefault();
        return;
      }
      // In multi-select mode a row click toggles selection instead of
      // opening the reader — the user is explicitly building a batch.
      if (selectionMode && onToggleSelected) {
        e.preventDefault();
        onToggleSelected(chapter.id);
        return;
      }
      // Parent always supplies `onChapterClick`; navigation is its job.
      onChapterClick?.(chapter.id);
    },
    [onChapterClick, selectionMode, onToggleSelected],
  );

  const openMenu = useCallback((chapter: Chapter, x: number, y: number) => {
    suppressClickUntilRef.current = Date.now() + 600;
    // Clamp against the viewport: the menu is centered on x with
    // translate(-50%, 0), so keep half its ~190px width on screen.
    const half = 96;
    const clampedX = Math.min(Math.max(x, half), Math.max(half, window.innerWidth - half));
    // Same for y — keep the whole menu (~200px tall) inside the screen.
    const menuHeight = 200;
    const clampedY = Math.min(y, Math.max(8, window.innerHeight - menuHeight));
    setMenuPos({ x: clampedX, y: clampedY });
    setMenu({ chapter });
    setLongPressingId(null);
  }, []);

  const onDown = useCallback(
    (chapter: Chapter, e: React.MouseEvent | React.TouchEvent) => {
      const ev = e as unknown as { clientX: number; clientY: number; touches?: Array<{ clientX: number; clientY: number }> };
      const touch = ev.touches?.[0];
      const clientX = touch?.clientX ?? ev.clientX;
      const clientY = touch?.clientY ?? ev.clientY;
      pressStartRef.current = { x: clientX, y: clientY, id: chapter.id };
      timerRef.current = setTimeout(() => {
        if (pressStartRef.current?.id === chapter.id) {
          openMenu(chapter, clientX, clientY);
        }
      }, LONG_PRESS_MS);
    },
    [openMenu],
  );

  const onMove = useCallback(
    (chapter: Chapter, e: React.MouseEvent | React.TouchEvent) => {
      if (!pressStartRef.current || pressStartRef.current.id !== chapter.id) return;
      const ev = e as unknown as { clientX: number; clientY: number; touches?: Array<{ clientX: number; clientY: number }> };
      const touch = ev.touches?.[0];
      const clientX = touch?.clientX ?? ev.clientX;
      const clientY = touch?.clientY ?? ev.clientY;
      const dx = clientX - pressStartRef.current.x;
      const dy = clientY - pressStartRef.current.y;
      if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_PX) clearPress();
    },
    [clearPress],
  );

  const onUp = useCallback(() => clearPress(), [clearPress]);

  const handleAction = useCallback(
    (action: 'read' | 'unread' | 'bookmark' | 'unbookmark', chapter: Chapter) => {
      setMenu(null);
      onChapterAction?.(action, chapter);
    },
    [onChapterAction],
  );

  return (
    <div className="chapter-list-container">
      <ul className="chapter-list" role="list" aria-label="Chapters">
        {sortedChapters.map((chapter) => {
          const started = readChapterIds?.has(chapter.id) ?? false;
          const bookmarked = bookmarkedChapterIds?.has(chapter.id) ?? false;
          const pressing = longPressingId === chapter.id;
          const selected = selectedIds?.has(chapter.id) ?? false;
          const marker = chapterMarker(chapter);
          const publishedLabel = formatDate(chapter.publishedAt);
          const rowClassName = `chapter-list__item${started ? ' chapter-list__item--read' : ''}${bookmarked ? ' chapter-list__item--bookmarked' : ''}${pressing ? ' chapter-list__item--pressing' : ''}${selected ? ' chapter-list__item--selected' : ''}`;
          const rowAriaLabel = `${chapter.title}${started ? ', in progress' : ''}${bookmarked ? ', bookmarked' : ''}${selected ? ', selected' : ''}${chapter.publishedAt ? `, published ${formatDate(chapter.publishedAt)}` : ''}`;
          const rowOnClick = (e: React.MouseEvent) => {
            if (pressing || Date.now() < suppressClickUntilRef.current) {
              e.preventDefault();
              clearPress();
              return;
            }
            handleClick(chapter, e);
          };
          const rowOnKeyDown = (e: React.KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              if (selectionMode && onToggleSelected) {
                onToggleSelected(chapter.id);
              } else if (onChapterClick) {
                onChapterClick(chapter.id);
              }
              clearPress();
              return;
            }
            onKeyDown?.(e, chapter.id);
          };
          const pointerProps = {
            onPointerDown: (e: React.PointerEvent) => onDown(chapter, e),
            onPointerMove: (e: React.PointerEvent) => onMove(chapter, e),
            onPointerUp: onUp,
            onPointerCancel: onUp,
            onPointerLeave: onUp,
          };
          const rowContent = (
                <div className="chapter-list__content">
                  <div className="chapter-list__title-group">
                    <span className="chapter-list__title">{chapter.title}</span>
                    {marker === 'filler' && (
                      <span
                        className="chapter-list__marker chapter-list__marker--filler"
                        title="Side content — safe to skip without missing the main story"
                      >
                        Filler
                      </span>
                    )}
                    {panelId && (
                      <ChapterBookmarkButton
                        chapter={chapter}
                        panelId={panelId}
                        bookmarked={bookmarked}
                      />
                    )}
                    {downloader && (
                      <ChapterDownloadButton
                        chapter={chapter}
                        isActive={downloader.isActive(chapter.id)}
                        isDone={downloader.isDone(chapter.id)}
                        isCancelled={downloader.isCancelled(chapter.id)}
                        isFailed={downloader.isFailed(chapter.id)}
                        progressLabel={downloader.progressLabel(chapter.id)}
                        onDownload={() => downloader.startOne(chapter)}
                        onCancel={downloader.cancelOne}
                      />
                    )}
                    {/* Multi-select checkbox sits next to the per-row download
                        button so the two actions group together on the right
                        edge of the row (the row's left-edge accent stripe
                        still flags selection state visually). Rendered
                        last so the title's `flex: 1` keeps the title left
                        and the action cluster (bookmark + download +
                        checkbox) right-aligned as a single block. */}
                    {selectionMode && onToggleSelected && (
                      <ChapterSelectCheckbox
                        checked={selected}
                        chapterTitle={chapter.title}
                        onChange={() => onToggleSelected(chapter.id)}
                      />
                    )}
                  </div>
                  {publishedLabel && (
                    <div className="chapter-list__meta">
                      <time
                        className="chapter-list__date"
                        dateTime={chapter.publishedAt ?? undefined}
                      >
                        {publishedLabel}
                      </time>
                    </div>
                  )}
                </div>
          );
          return (
            <li key={chapter.id} className="chapter-list__item-wrapper">
              <Link
                to={`/read/${encodeURIComponent(chapter.id)}`}
                className={rowClassName}
                aria-label={rowAriaLabel}
                onClick={rowOnClick}
                onKeyDown={rowOnKeyDown}
                {...pointerProps}
              >
                {rowContent}
              </Link>
            </li>
          );
        })}
      </ul>

      {menu && (() => {
        return (
        <div
          className="chapter-context-menu"
          style={{
            position: 'fixed',
            top: menuPos.y,
            left: menuPos.x,
            transform: 'translate(-50%, 0)',
            zIndex: 1000,
          }}
          role="menu"
          aria-label={`Actions for ${menu.chapter.title}`}
        >
          <button
            type="button"
            role="menuitem"
            className="chapter-context-menu__item"
            onClick={() => handleAction('read', menu.chapter)}
          >
            Mark read
          </button>
          <button
            type="button"
            role="menuitem"
            className="chapter-context-menu__item"
            onClick={() => handleAction('unread', menu.chapter)}
          >
            Mark unread
          </button>
          <button
            type="button"
            role="menuitem"
            className="chapter-context-menu__item"
            onClick={() => handleAction('bookmark', menu.chapter)}
          >
            Bookmark chapter
          </button>
          <button
            type="button"
            role="menuitem"
            className="chapter-context-menu__item"
            onClick={() => handleAction('unbookmark', menu.chapter)}
          >
            Remove bookmark
          </button>
          <button
            type="button"
            role="menuitem"
            className="chapter-context-menu__item"
            onClick={() => {
              setMenu(null);
              if (downloader) downloader.startOne(menu.chapter);
            }}
            disabled={!downloader || downloader.isActive(menu.chapter.id)}
          >
            {downloader?.isActive(menu.chapter.id)
              ? 'Downloading…'
              : downloader?.isDone(menu.chapter.id)
                ? 'Re-download chapter'
                : 'Download chapter'}
          </button>
          <button
            type="button"
            role="menuitem"
            className="chapter-context-menu__item"
            onClick={() => {
              setMenu(null);
              onReadChapter?.(menu.chapter.id);
            }}
          >
            Read chapter
          </button>
        </div>
        );
      })()}
    </div>
  );
}
