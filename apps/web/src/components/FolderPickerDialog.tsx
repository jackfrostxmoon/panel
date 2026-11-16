import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  useAddBookmarkToFolder,
  useBookmarkFolders,
  useCreateBookmarkFolder,
  useRemoveBookmarkFromFolder,
} from '../api/hooks';
import { useToast } from './Toast';

/**
 * Modal folder picker (T2-8). Lets the user toggle a single bookmark's
 * folder memberships with checkboxes. The default "All bookmarks" folder is
 * always shown, is checked by default for a new bookmark, and cannot be
 * unchecked (a bookmark always lives somewhere).
 *
 * Used in two places:
 *  - Panel details page: opens right after the user clicks Bookmark, so
 *    the freshly-added bookmark lands in the picked folders immediately.
 *  - Bookmarks grid: a per-card "Move to folder…" trigger.
 */
export function FolderPickerDialog({
  open,
  bookmark,
  onClose,
  /** Optional callback fired after the user clicks Done so the parent can refresh. */
  onApplied,
}: {
  open: boolean;
  /** The bookmark to edit, or null when there's nothing to assign (closed). */
  bookmark: { id: string; folderIds: string[] } | null;
  onClose: () => void;
  onApplied?: () => void;
}) {
  const folders = useBookmarkFolders();
  const createFolder = useCreateBookmarkFolder();
  const addItem = useAddBookmarkToFolder();
  const removeItem = useRemoveBookmarkFromFolder();
  const { toast } = useToast();
  /** Local working copy of the membership set — the dialog doesn't write
   *  through to the server until Done is clicked, so users can cancel. */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Reset the local selection every time the dialog opens for a different
  // bookmark (or re-opens for the same one with a fresh state). The
  // folderIds reference is captured into a stable string so the effect
  // doesn't refire on every parent render.
  const bookmarkId = bookmark?.id ?? null;
  const folderIdsKey = bookmark?.folderIds.join('|') ?? '';
  useEffect(() => {
    if (!open || !bookmark) return;
    setSelected(new Set(bookmark.folderIds));
    setCreating(false);
    setNewName('');
  }, [open, bookmarkId, folderIdsKey, bookmark]);

  // Mirror the open prop into the native dialog.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const allFolders = folders.data?.folders ?? [];
  const defaultFolder = allFolders.find((f) => f.isDefault) ?? null;
  const customFolders = allFolders.filter((f) => !f.isDefault);
  const initial = bookmark?.folderIds ?? [];
  const dirty = (() => {
    if (!bookmark) return false;
    if (selected.size !== initial.length) return true;
    for (const id of selected) if (!initial.includes(id)) return true;
    return false;
  })();

  const toggle = (folderId: string) => {
    // The default folder is always a member — a checkbox would be misleading.
    if (defaultFolder && folderId === defaultFolder.id) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  };

  const handleCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    try {
      const created = await createFolder.mutateAsync({ name: trimmed });
      // Auto-check the fresh folder so it's applied on Done.
      setSelected((prev) => new Set(prev).add(created.id));
      setNewName('');
      setCreating(false);
      toast(`Folder "${trimmed}" created`, 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not create folder.', 'error');
    }
  };

  const handleApply = async () => {
    if (!bookmark) return;
    setSaving(true);
    try {
      const toAdd: string[] = [];
      const toRemove: string[] = [];
      for (const id of selected) {
        if (!initial.includes(id)) toAdd.push(id);
      }
      for (const id of initial) {
        if (defaultFolder && id === defaultFolder.id) continue;
        if (!selected.has(id)) toRemove.push(id);
      }
      // Run in order — removes first so a swap (e.g. A → B) never briefly
      // leaves the bookmark with no folder (the default is always set,
      // so this is just defensive).
      for (const folderId of toRemove) {
        await removeItem.mutateAsync({ folderId, bookmarkId: bookmark.id });
      }
      for (const folderId of toAdd) {
        await addItem.mutateAsync({ folderId, bookmarkId: bookmark.id });
      }
      if (toAdd.length > 0 || toRemove.length > 0) {
        toast(
          toAdd.length > 0
            ? `Added to ${toAdd.length} folder${toAdd.length === 1 ? '' : 's'}.`
            : `Removed from ${toRemove.length} folder${toRemove.length === 1 ? '' : 's'}.`,
          'success',
        );
      }
      onApplied?.();
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not update folders.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <dialog
      ref={dialogRef}
      className="dialog folder-picker"
      aria-labelledby="folder-picker-title"
      onClose={onClose}
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === dialogRef.current) onClose();
      }}
    >
      <div className="dialog__body folder-picker__body">
        <h2 id="folder-picker-title" className="dialog__title">
          Choose folders
        </h2>
        <p className="folder-picker__hint">
          A bookmark can live in multiple folders. All bookmarks is always on.
        </p>

        <ul className="folder-picker__list" role="group" aria-label="Folders">
          {defaultFolder && (
            <li>
              <label className="folder-picker__row folder-picker__row--default">
                <input
                  type="checkbox"
                  checked
                  disabled
                  aria-label="All bookmarks (always included)"
                />
                <span className="folder-picker__name">All bookmarks</span>
                <span className="folder-picker__default-pill">Default</span>
              </label>
            </li>
          )}
          {customFolders.length === 0 && !defaultFolder && (
            <li className="folder-picker__empty">No folders yet — create one below.</li>
          )}
          {customFolders.map((folder) => (
            <li key={folder.id}>
              <label className="folder-picker__row">
                <input
                  type="checkbox"
                  checked={selected.has(folder.id)}
                  onChange={() => toggle(folder.id)}
                  aria-label={`Put this bookmark in ${folder.name}`}
                />
                <span className="folder-picker__name">{folder.name}</span>
              </label>
            </li>
          ))}
        </ul>

        {creating ? (
          <form
            className="folder-picker__create"
            onSubmit={(e) => {
              e.preventDefault();
              void handleCreate();
            }}
          >
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Folder name"
              autoFocus
              aria-label="New folder name"
              disabled={createFolder.isPending}
            />
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setCreating(false);
                setNewName('');
              }}
              disabled={createFolder.isPending}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn--primary btn--sm"
              disabled={createFolder.isPending || !newName.trim()}
            >
              {createFolder.isPending ? 'Creating…' : 'Create'}
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="folder-picker__new-btn"
            onClick={() => setCreating(true)}
          >
            <span aria-hidden="true">+</span> New folder
          </button>
        )}

        <div className="dialog__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={handleApply}
            disabled={saving || !dirty}
            autoFocus
          >
            {saving ? 'Saving…' : 'Done'}
          </button>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
