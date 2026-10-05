import { Link } from 'react-router-dom';
import { useCallback, useMemo } from 'react';
import type { Chapter } from '@panel/shared';
import { useAddChapterBookmark, useChapterBookmarks, useRemoveChapterBookmark } from '../api/hooks';
import { useToast } from '../components/Toast';
import { IconArrowLeft, IconBookmark, IconCompress, IconExpand, IconGear, IconX } from '../components/icons';

/**
 * Shared chapter-bookmark toggle for the reader: the toolbar button and the
 * `V` keyboard shortcut (handled in `ReaderPage`) run the same mutation with
 * the same toasts, so the two can never drift apart.
 */
// oxlint-disable-next-line react/only-export-components -- shared toggle hook co-located with its toolbar
export function useChapterBookmarkToggle({
  panelId,
  chapterTitle,
  chapterId,
  chapters,
}: {
  panelId: string;
  chapterTitle: string | null;
  chapterId: string;
  chapters: Chapter[];
}) {
  const chapterBookmarks = useChapterBookmarks(panelId);
  const addBookmark = useAddChapterBookmark();
  const removeBookmark = useRemoveChapterBookmark();
  const { toast } = useToast();

  const bookmarkedChapterIds = useMemo(() => {
    const ids = new Set<string>();
    for (const bookmark of chapterBookmarks.data ?? []) {
      ids.add(bookmark.chapterId);
    }
    return ids;
  }, [chapterBookmarks.data]);

  const isCurrentChapterBookmarked = bookmarkedChapterIds.has(chapterId);

  const toggleBookmark = useCallback(async () => {
    // Guard the loading window: the page-level `V` shortcut exists before
    // the chapter payload arrives (the toolbar only mounts once it has).
    if (!panelId || !chapterId) return;
    try {
      if (isCurrentChapterBookmarked) {
        await removeBookmark.mutateAsync({ panelId, chapterId });
        toast(`Removed bookmark from "${chapterTitle ?? 'Chapter'}"`, 'success');
      } else {
        await addBookmark.mutateAsync({
          panelId,
          chapterId,
          title:
            chapters.find((c) => c.id === chapterId)?.title ?? chapterTitle ?? 'Unknown Chapter',
          chapterNumber: chapters.find((c) => c.id === chapterId)?.chapterNumber ?? null,
          sourceUrl: chapters.find((c) => c.id === chapterId)?.sourceUrl ?? '',
          publishedAt: chapters.find((c) => c.id === chapterId)?.publishedAt ?? null,
        });
        toast(`Bookmarked "${chapterTitle ?? 'Chapter'}"`, 'success');
      }
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'Could not update chapter bookmark.',
        'error',
      );
    }
  }, [panelId, chapterId, chapterTitle, chapters, isCurrentChapterBookmarked, addBookmark, removeBookmark, toast]);

  return {
    isCurrentChapterBookmarked,
    toggleBookmark,
    isBookmarkPending: addBookmark.isPending || removeBookmark.isPending,
  };
}

/**
 * Reader top toolbar: navigation back to the panel, chapter context,
 * chapter prev/next, settings and fullscreen. Slides away when
 * `visible` is false (auto-hide).
 */
export function ReaderToolbar({
  panelId,
  panelTitle,
  chapterTitle,
  chapterId,
  chapters,
  visible,
  isFullscreen,
  settingsOpen,
  autoScrollActive,
  autoScrollRunning,
  showAutoScrollButton,
  onToggleFullscreen,
  onToggleAutoScroll,
  onOpenSettings,
}: {
  panelId: string;
  panelTitle: string | null;
  chapterTitle: string | null;
  chapterId: string;
  chapters: Chapter[];
  visible: boolean;
  isFullscreen: boolean;
  settingsOpen: boolean;
  /** Whether the paced auto-scroll toggle is turned on (T1-2). */
  autoScrollActive: boolean;
  /** False when auto-scroll has paused at the last page (still "on" but stalled). */
  autoScrollRunning: boolean;
  /** Whether the auto-scroll button is visible in the toolbar. Hidden by default. */
  showAutoScrollButton: boolean;
  onToggleFullscreen: () => void;
  onToggleAutoScroll: () => void;
  onOpenSettings: () => void;
}) {
  const { isCurrentChapterBookmarked, toggleBookmark, isBookmarkPending } =
    useChapterBookmarkToggle({ panelId, chapterTitle, chapterId, chapters });

  return (
    <>
      <header className={`reader-toolbar${visible ? '' : ' reader-toolbar--hidden'}`}>
        <div className="reader-toolbar__group">
          <Link
            to={`/panel/${encodeURIComponent(panelId)}`}
            className="reader-toolbar__btn"
            aria-label="Back to panel details"
            title="Back to panel (Esc)"
          >
            <IconArrowLeft size={18} />
          </Link>
          <div className="reader-toolbar__titles">
            <span className="reader-toolbar__panel">{panelTitle ?? 'Panel'}</span>
            <span className="reader-toolbar__chapter">{chapterTitle ?? 'Chapter'}</span>
          </div>
        </div>

        <div className="reader-toolbar__group">
          <button
            type="button"
            className={`reader-toolbar__btn chapter-bookmark-toolbar-btn${isCurrentChapterBookmarked ? ' chapter-bookmark-toolbar-btn--active' : ''}`}
            onClick={() => void toggleBookmark()}
            aria-label={isCurrentChapterBookmarked ? 'Remove bookmark from this chapter' : 'Bookmark this chapter'}
            title={isCurrentChapterBookmarked ? 'Remove bookmark (V)' : 'Bookmark chapter (V)'}
            aria-pressed={isCurrentChapterBookmarked}
            aria-keyshortcuts="v"
            disabled={isBookmarkPending}
          >
            <span aria-hidden="true" className="chapter-bookmark-toolbar-btn__icon">
              <IconBookmark size={18} filled={isCurrentChapterBookmarked} />
            </span>
          </button>
          {showAutoScrollButton && (
          <button
            type="button"
            className={`reader-toolbar__btn reader-toolbar__auto-scroll${autoScrollActive ? ' reader-toolbar__auto-scroll--on' : ''}`}
            onClick={onToggleAutoScroll}
            aria-label={autoScrollActive ? 'Stop auto-scroll' : 'Start auto-scroll'}
            title={autoScrollActive ? 'Stop auto-scroll (hands-free page turning)' : 'Auto-scroll (hands-free page turning)'}
            aria-pressed={autoScrollActive}
          >
            <span aria-hidden="true" className="reader-toolbar__auto-scroll__icon">
              {autoScrollActive ? (
                autoScrollRunning ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <polygon points="6 5 20 12 6 19" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="5" width="4" height="14" />
                    <rect x="14" y="5" width="4" height="14" />
                  </svg>
                )
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="6 5 20 12 6 19" />
                </svg>
              )}
            </span>
          </button>
          )}
          <button
            type="button"
            className="reader-toolbar__btn reader-toolbar__btn--fullscreen"
            onClick={onToggleFullscreen}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            title={isFullscreen ? 'Exit fullscreen (E)' : 'Fullscreen (E)'}
          >
            {isFullscreen ? <IconCompress size={18} /> : <IconExpand size={18} />}
          </button>
          <button
            type="button"
            className={`reader-toolbar__btn${settingsOpen ? ' reader-toolbar__btn--active' : ''}`}
            onClick={onOpenSettings}
            aria-label={settingsOpen ? 'Close reader settings' : 'Open reader settings'}
            title={settingsOpen ? 'Close settings (Esc)' : 'Reader settings'}
            aria-pressed={settingsOpen}
          >
            {settingsOpen ? <IconX size={18} /> : <IconGear size={18} />}
          </button>
        </div>
      </header>
    </>
  );
}
