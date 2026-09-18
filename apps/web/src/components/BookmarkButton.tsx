import { useState } from 'react';
import type { Panel } from '@panel/shared';
import {
  useAddBookmark,
  useBookmarkByPanel,
  useBookmarkFolders,
  useRemoveBookmark,
} from '../api/hooks';
import { useToast } from './Toast';
import { ConfirmDialog } from './ConfirmDialog';
import { FolderPickerDialog } from './FolderPickerDialog';
import { IconBookmark } from './icons';


/**
 * Bookmark controls for the details toolbar. Each is rendered as its own
 * pill segment so the toggle and folder picker read as detached segments
 * matching the rest of the unified toolbar (rating, status, share) — no
 * internal hairline divider or fused-pair container.
 */

/**
 * Bookmark toggle segment. Owns its own confirm-remove dialog and the
 * folder-picker dialog that auto-opens after adding, but only when there
 * is a choice to make (more than one folder exists).
 */
export function BookmarkToggle({ panel }: { panel: Panel }) {
  const { data: bookmark, isLoading } = useBookmarkByPanel(panel.id);
  const { data: folderData } = useBookmarkFolders();
  const addBookmark = useAddBookmark();
  const removeBookmark = useRemoveBookmark();
  const { toast } = useToast();
  const [justAdded, setJustAdded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const busy = addBookmark.isPending || removeBookmark.isPending || isLoading;

  const handleClick = () => {
    if (bookmark) {
      setConfirming(true);
      return;
    }
    void addBookmark
      .mutateAsync({
        panelId: panel.id,
        title: panel.title,
        coverUrl: panel.coverUrl,
        source: panel.source,
        sourceUrl: panel.sourceUrl,
      })
      .then(() => {
        setJustAdded(true);
        window.setTimeout(() => setJustAdded(false), 450);
        toast('Added to bookmarks', 'success');
        // Skip the folder picker when there is no choice to make (a single
        // folder, or the folder list hasn't loaded) — the bookmark already
        // lives in the only available folder.
        if ((folderData?.folders.length ?? 0) > 1) {
          setPickerOpen(true);
        }
      })
      .catch((error: unknown) => {
        toast(error instanceof Error ? error.message : 'Could not add bookmark.', 'error');
      });
  };

  const handleRemove = async () => {
    if (!bookmark) return;
    try {
      await removeBookmark.mutateAsync({ id: bookmark.id, panelId: panel.id });
      toast('Removed from bookmarks');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not remove bookmark.', 'error');
    } finally {
      setConfirming(false);
    }
  };

  const pickerBookmark =
    bookmark && (bookmark.folderIds ?? []).length > 0
      ? { id: bookmark.id, folderIds: bookmark.folderIds ?? [] }
      : null;

  return (
    <>
      <button
        type="button"
        className={`btn bookmark-btn${bookmark ? ' bookmark-btn--active' : ''}${
          justAdded ? ' bookmark-btn--pop' : ''
        }`}
        aria-pressed={bookmark != null}
        aria-label={bookmark ? `Remove ${panel.title} from bookmarks` : `Bookmark ${panel.title}`}
        disabled={busy}
        onClick={handleClick}
      >
        <span aria-hidden="true" className="bookmark-btn__icon">
          <IconBookmark size={16} filled={bookmark != null} />
        </span>
        {bookmark ? 'Bookmarked' : 'Bookmark'}
      </button>
      <ConfirmDialog
        open={confirming}
        title="Remove bookmark?"
        message={`"${panel.title}" will be removed from your bookmarks. Your reading progress is kept.`}
        confirmLabel="Remove"
        danger
        onConfirm={handleRemove}
        onCancel={() => setConfirming(false)}
      />
      <FolderPickerDialog
        open={pickerOpen && pickerBookmark !== null}
        bookmark={pickerBookmark}
        onClose={() => setPickerOpen(false)}
      />
    </>
  );
}

/**
 * Folder-picker segment. Only renders once the panel is bookmarked — the
 * segment is reserved in the toolbar markup so the layout doesn't shift
 * when the bookmark state changes (handled by the parent toolbar item).
 */
export function BookmarkFolderPicker({ panel }: { panel: Panel }) {
  const { data: bookmark } = useBookmarkByPanel(panel.id);
  const [pickerOpen, setPickerOpen] = useState(false);

  if (!bookmark) return null;

  const pickerBookmark =
    (bookmark.folderIds ?? []).length > 0
      ? { id: bookmark.id, folderIds: bookmark.folderIds ?? [] }
      : null;

  return (
    <>
      <button
        type="button"
        className="btn btn--icon-only bookmark-btn-folder"
        aria-label={`Edit folders for ${panel.title}`}
        title="Edit folders"
        onClick={() => setPickerOpen(true)}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
      </button>
      <FolderPickerDialog
        open={pickerOpen && pickerBookmark !== null}
        bookmark={pickerBookmark}
        onClose={() => setPickerOpen(false)}
      />
    </>
  );
}
