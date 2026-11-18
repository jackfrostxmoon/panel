import { useState } from 'react';
import type { Chapter } from '@panel/shared';
import { useAddChapterBookmark, useRemoveChapterBookmark } from '../api/hooks';
import { useToast } from './Toast';
import { ConfirmDialog } from './ConfirmDialog';
import { IconBookmark } from './icons';
import { useIncognito } from '../hooks/useIncognito';

interface ChapterBookmarkButtonProps {
  chapter: Chapter;
  panelId: string;
  bookmarked: boolean;
  onToggle?: () => void;
}

export function ChapterBookmarkButton({
  chapter,
  panelId,
  bookmarked,
  onToggle,
}: ChapterBookmarkButtonProps) {
  const addBookmark = useAddChapterBookmark();
  const removeBookmark = useRemoveChapterBookmark();
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const { enabled: incognito } = useIncognito();

  const busy = addBookmark.isPending || removeBookmark.isPending;

  // Incognito: chapter bookmarks are hidden entirely.
  if (incognito) return null;

  const handleAdd = async () => {
    try {
      await addBookmark.mutateAsync({
        panelId,
        chapterId: chapter.id,
        title: chapter.title,
        chapterNumber: chapter.chapterNumber,
        sourceUrl: chapter.sourceUrl,
        publishedAt: chapter.publishedAt,
      });
      toast('Chapter bookmarked', 'success');
      onToggle?.();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not bookmark chapter.', 'error');
    }
  };

  const handleRemove = async () => {
    try {
      await removeBookmark.mutateAsync({ panelId, chapterId: chapter.id });
      toast('Chapter bookmark removed');
      onToggle?.();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not remove bookmark.', 'error');
    } finally {
      setConfirming(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className={`btn btn--ghost btn--icon-only chapter-bookmark-btn${bookmarked ? ' chapter-bookmark-btn--active' : ''}`}
        aria-pressed={bookmarked}
        aria-label={bookmarked ? `Remove bookmark for ${chapter.title}` : `Bookmark ${chapter.title}`}
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          if (bookmarked) setConfirming(true);
          else handleAdd();
        }}
      >
        <span aria-hidden="true" className="chapter-bookmark-btn__icon">
          <IconBookmark size={16} filled={bookmarked} />
        </span>
      </button>

      <ConfirmDialog
        open={confirming}
        title="Remove chapter bookmark?"
        message={`"${chapter.title}" will be removed from your chapter bookmarks.`}
        confirmLabel="Remove"
        danger
        onConfirm={handleRemove}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}