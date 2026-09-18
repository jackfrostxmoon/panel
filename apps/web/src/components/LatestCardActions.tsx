import { useState, type MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import { IconFolder } from './icons';
import { FolderPickerDialog } from './FolderPickerDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { useAddBookmark, useBookmarks, useRemoveBookmark } from '../api/hooks';
import { useToast } from './Toast';
import type { PanelCardProgress } from './PanelCard';

/**
 * Hover-revealed action strip for a Latest/Search panel card. Mirrors the
 * bookmarks grid's button row (Continue / Folder / Open / Remove) so the
 * two card styles feel related and the same set of actions is reachable
 * without bouncing through the details page.
 *
 * When the panel isn't bookmarked yet, Folder + Remove are swapped for a
 * single Add button so the strip never ends up with empty slots.
 */
export function LatestCardActions({
  panelId,
  title,
  source,
  sourceUrl,
  coverUrl,
  isBookmarked,
  progress,
}: {
  panelId: string;
  title: string;
  source: string;
  sourceUrl: string;
  coverUrl: string | null;
  isBookmarked: boolean;
  progress: PanelCardProgress | null;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const addBookmark = useAddBookmark();
  const removeBookmark = useRemoveBookmark();
  const bookmarks = useBookmarks();
  const { toast } = useToast();
  const bookmark = (bookmarks.data ?? []).find((b) => b.panelId === panelId) ?? null;

  /** Stop the click from reaching the wrapping stretched-link. */
  const swallow = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleRemove = async () => {
    if (!bookmark) {
      setConfirmRemove(false);
      return;
    }
    try {
      await removeBookmark.mutateAsync({ id: bookmark.id, panelId });
      toast(`Removed "${title}" from bookmarks`);
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'Could not remove bookmark.',
        'error',
      );
    } finally {
      setConfirmRemove(false);
    }
  };

  const handleAdd = async () => {
    try {
      await addBookmark.mutateAsync({
        panelId,
        title,
        source,
        sourceUrl,
        coverUrl,
      });
      toast('Added to bookmarks', 'success');
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'Could not add bookmark.',
        'error',
      );
    }
  };

  const openUrl = `/panel/${encodeURIComponent(panelId)}?from=latest`;

  return (
    <>
      <div className="latest-card-actions" onClick={swallow}>
        {progress && (
          <Link
            to={`/read/${encodeURIComponent(progress.chapterId)}`}
            className="btn btn--primary btn--sm latest-card-actions__continue"
            aria-label={`Continue reading ${title}`}
            title="Continue reading"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86a1 1 0 0 0-1.5.86Z" />
            </svg>
            <span>Continue</span>
          </Link>
        )}
        {isBookmarked ? (
          <>
            <button
              type="button"
              className="btn btn--ghost btn--sm latest-card-actions__folder"
              aria-label={`Move ${title} to a folder`}
              title="Move to folder"
              onClick={() => setPickerOpen(true)}
            >
              <IconFolder size={14} />
              <span>Folder</span>
            </button>
            <Link
              to={openUrl}
              className="btn btn--ghost btn--sm latest-card-actions__open"
              aria-label={`Open ${title}`}
              title="Open panel"
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
                <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
              </svg>
              <span>Open</span>
            </Link>
            <button
              type="button"
              className="btn btn--danger-ghost btn--sm latest-card-actions__remove"
              aria-label={`Remove ${title} from bookmarks`}
              title="Remove from bookmarks"
              onClick={() => setConfirmRemove(true)}
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
                <path d="M3 6h18" />
                <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                <path d="M10 11v6" />
                <path d="M14 11v6" />
              </svg>
              <span>Remove</span>
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn--ghost btn--sm latest-card-actions__add"
            aria-label={`Add ${title} to bookmarks`}
            title="Add to bookmarks"
            onClick={handleAdd}
            disabled={addBookmark.isPending}
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
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
            </svg>
            <span>Bookmark</span>
          </button>
        )}
      </div>
      {isBookmarked && (
        <FolderPickerDialog
          open={pickerOpen && Boolean(bookmark)}
          bookmark={bookmark ? { id: bookmark.id, folderIds: bookmark.folderIds ?? [] } : null}
          onClose={() => setPickerOpen(false)}
        />
      )}
      <ConfirmDialog
        open={confirmRemove}
        title="Remove bookmark?"
        message={`"${title}" will be removed from your bookmarks. Your reading progress is kept.`}
        confirmLabel="Remove"
        danger
        onConfirm={handleRemove}
        onCancel={() => setConfirmRemove(false)}
      />
    </>
  );
}
