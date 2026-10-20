import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { BULK_CHAPTER_LIMIT, type Chapter } from '@panel/shared';
import { useAddChapterBookmarks, useClearChapterBookmarks, useBulkMarkChaptersRead } from '../api/hooks';
import { useToast } from './Toast';
import { ConfirmDialog } from './ConfirmDialog';
import { IconArrowLeft, IconCheck, IconRefresh, IconUndo, IconX } from './icons';

interface ChapterBookmarkActionsProps {
  panelId: string;
  chapters: Chapter[];
  bookmarkedCount: number;
  onClearReadTracker?: () => void;
  /**
   * Optional "Select chapters" entry button. The page renders this slot
   * next to the "Mark All Read" / "Unmark All" pair so the two bulk-action
   * entry points read as siblings in the same flex row.
   */
  selectChaptersSlot?: ReactNode;
  /**
   * "Mark until here" target: the unread chapters before the user's
   * current chapter (computed by the page), or null when there is no
   * Continue-Reading chapter or nothing is unread before it. The
   * component only renders the button + confirmation and fires the
   * bulk endpoint — all ordering logic lives on the page.
   */
  markUntil?: { chapters: Chapter[]; currentLabel: string } | null;
}

export function ChapterBookmarkActions({
  panelId,
  chapters,
  bookmarkedCount,
  onClearReadTracker,
  selectChaptersSlot,
  markUntil,
}: ChapterBookmarkActionsProps) {
  const addBookmarks = useAddChapterBookmarks();
  const clearBookmarks = useClearChapterBookmarks();
  const bulkMark = useBulkMarkChaptersRead();
  const { toast } = useToast();
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [confirmingBulkRead, setConfirmingBulkRead] = useState(false);
  const [confirmingBulkUnread, setConfirmingBulkUnread] = useState(false);
  const [confirmingMarkUntil, setConfirmingMarkUntil] = useState(false);

  const busy = addBookmarks.isPending || clearBookmarks.isPending || bulkMark.isPending;

  /** The API caps a bulk payload at `BULK_CHAPTER_LIMIT` chapters (same
      constant on the server's Zod schemas), so long panel are sent in
      chunks and the counts aggregated (T1-6). */
  const bulkMarkInChunks = useCallback(
    async (chapters: Chapter[], read: boolean) => {
      let markedRead = 0;
      let markedUnread = 0;
      for (let i = 0; i < chapters.length; i += BULK_CHAPTER_LIMIT) {
        const result = await bulkMark.mutateAsync({
          panelId,
          chapters: chapters.slice(i, i + BULK_CHAPTER_LIMIT).map((ch) => ({ chapterId: ch.id, read })),
        });
        markedRead += result.markedRead;
        markedUnread += result.markedUnread;
      }
      return { markedRead, markedUnread };
    },
    [bulkMark, panelId],
  );

  const handleBookmarkAll = async () => {
    if (chapters.length === 0) {
      toast('No chapters to bookmark', 'info');
      return;
    }
    try {
      await addBookmarks.mutateAsync({
        panelId,
        chapters: chapters.map((ch) => ({
          chapterId: ch.id,
          title: ch.title,
          chapterNumber: ch.chapterNumber,
          sourceUrl: ch.sourceUrl,
          publishedAt: ch.publishedAt,
        })),
      });
      toast(`Bookmarked ${chapters.length} chapter${chapters.length === 1 ? '' : 's'}`, 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not bookmark chapters.', 'error');
    }
  };

  const handleClearBookmarks = async () => {
    try {
      await clearBookmarks.mutateAsync(panelId);
      toast('All chapter bookmarks cleared', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not clear bookmarks.', 'error');
    } finally {
      setConfirmingClear(false);
    }
  };

  const handleClearReadTracker = () => {
    if (onClearReadTracker) {
      onClearReadTracker();
    } else {
      toast('Clear read tracker not available', 'info');
    }
  };

  /** Bulk mark every matching chapter as read (T1-6). */
  const handleMarkAllRead = async () => {
    if (chapters.length === 0) {
      toast('No chapters to mark read', 'info');
      return;
    }
    try {
      const result = await bulkMarkInChunks(chapters, true);
      toast(
        `Marked ${result.markedRead} chapter${result.markedRead === 1 ? '' : 's'} read`,
        'success',
      );
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not mark chapters read.', 'error');
    }
  };

  /** Bulk unmark every matching chapter (T1-6). */
  const handleMarkAllUnread = async () => {
    if (chapters.length === 0) {
      toast('No chapters to unmark', 'info');
      return;
    }
    try {
      const result = await bulkMarkInChunks(chapters, false);
      toast(
        `Unmarked ${result.markedUnread} chapter${result.markedUnread === 1 ? '' : 's'}`,
        'success',
      );
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not unmark chapters.', 'error');
    }
  };

  /** Bulk mark every chapter before the current one as read. */
  const handleMarkUntilHere = async () => {
    if (!markUntil || markUntil.chapters.length === 0) {
      toast('No previous chapters to mark read', 'info');
      return;
    }
    try {
      const result = await bulkMarkInChunks(markUntil.chapters, true);
      toast(
        `Marked ${result.markedRead} chapter${result.markedRead === 1 ? '' : 's'} read`,
        'success',
      );
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not mark chapters read.', 'error');
    }
  };

  return (
    <div className="chapter-bookmark-actions" role="group" aria-label="Chapter bookmark actions">
      <button
        type="button"
        className="btn btn--bookmark-multi"
        onClick={handleBookmarkAll}
        disabled={busy || chapters.length === 0}
        aria-label={`Batch bookmark all ${chapters.length} matching chapters`}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polygon points="12 2 2 7 12 12 22 7 12 2" />
          <polyline points="2 17 12 22 22 17" />
          <polyline points="2 12 12 17 22 12" />
        </svg>
        Bookmark All ({chapters.length})
      </button>

      {/* Bulk read actions (T1-6) + "Select chapters" entry. Grouped in a
          single cluster so the three buttons read as the same "bulk chapter
          action" family and are visually separated from the cleanup
          actions below. */}
      <div
        className="chapter-bookmark-actions__cluster"
        role="group"
        aria-label="Bulk chapter actions"
      >
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setConfirmingBulkRead(true)}
          disabled={busy || chapters.length === 0}
          aria-label={`Mark all ${chapters.length} matching chapters as read`}
          title="Mark all matching chapters as read"
        >
          <span aria-hidden="true"><IconCheck size={14} /></span>
          Mark All Read ({chapters.length})
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setConfirmingBulkUnread(true)}
          disabled={busy || chapters.length === 0}
          aria-label={`Unmark all ${chapters.length} matching chapters (clear read state)`}
          title="Unmark all matching chapters"
        >
          <span aria-hidden="true"><IconUndo size={14} /></span>
          Unmark All ({chapters.length})
        </button>
        {markUntil && markUntil.chapters.length > 0 && (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setConfirmingMarkUntil(true)}
            disabled={busy}
            aria-label={`Mark the ${markUntil.chapters.length} unread chapters before ${markUntil.currentLabel} as read`}
            title={`Mark all unread chapters before ${markUntil.currentLabel} as read`}
          >
            <span aria-hidden="true"><IconArrowLeft size={14} /></span>
            Mark Until Here ({markUntil.chapters.length})
          </button>
        )}
        {selectChaptersSlot}
      </div>

      {bookmarkedCount > 0 && (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setConfirmingClear(true)}
          disabled={busy}
          aria-label={`Clear all ${bookmarkedCount} chapter bookmarks`}
        >
          <span aria-hidden="true"><IconX size={14} /></span>
          Clear Bookmarks ({bookmarkedCount})
        </button>
      )}

      {onClearReadTracker && (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={handleClearReadTracker}
          disabled={busy}
          aria-label="Clear read progress tracker (greyed out chapters)"
        >
          <span aria-hidden="true"><IconRefresh size={14} /></span>
          Clear Read Tracker
        </button>
      )}

      <ConfirmDialog
        open={confirmingClear}
        title="Clear all chapter bookmarks?"
        message={`This will remove all ${bookmarkedCount} chapter bookmark${bookmarkedCount === 1 ? '' : 's'} for this panel. Your reading progress is kept.`}
        confirmLabel="Clear All"
        danger
        onConfirm={handleClearBookmarks}
        onCancel={() => setConfirmingClear(false)}
      />

      <ConfirmDialog
        open={confirmingBulkRead}
        title="Mark all chapters read?"
        message={`This marks all ${chapters.length} matching chapter${chapters.length === 1 ? '' : 's'} as read. You can undo it with "Unmark All" below.`}
        confirmLabel="Mark All Read"
        onConfirm={() => {
          setConfirmingBulkRead(false);
          void handleMarkAllRead();
        }}
        onCancel={() => setConfirmingBulkRead(false)}
      />

      <ConfirmDialog
        open={confirmingBulkUnread}
        title="Unmark all chapters?"
        message={`This clears the read state for all ${chapters.length} matching chapter${chapters.length === 1 ? '' : 's'}. Bookmarks are kept.`}
        confirmLabel="Unmark All"
        danger
        onConfirm={() => {
          setConfirmingBulkUnread(false);
          void handleMarkAllUnread();
        }}
        onCancel={() => setConfirmingBulkUnread(false)}
      />

      <ConfirmDialog
        open={confirmingMarkUntil}
        title={`Mark chapters before ${markUntil?.currentLabel ?? ''} read?`}
        message={`This marks the ${markUntil?.chapters.length ?? 0} unread chapter${(markUntil?.chapters.length ?? 0) === 1 ? '' : 's'} before ${markUntil?.currentLabel ?? ''} as read. You can undo it with "Unmark All" above.`}
        confirmLabel="Mark as Read"
        onConfirm={() => {
          setConfirmingMarkUntil(false);
          void handleMarkUntilHere();
        }}
        onCancel={() => setConfirmingMarkUntil(false)}
      />
    </div>
  );
}