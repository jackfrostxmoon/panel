import { useEffect, useState, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import { useBookmarkFolders } from '../api/hooks';
import { IconFolder } from './icons';


/**
 * Full-screen overlay shown while a bookmark card is being dragged. The
 * user drops the card onto a folder tile in this overlay to move the
 * bookmark there; dropping elsewhere or pressing Escape cancels.
 *
 * The overlay is a fixed-position layer that covers the viewport with a
 * dimmed backdrop. The backdrop uses `pointer-events: none` so it never
 * interferes with the underlying drag, while the folder tiles use
 * `pointer-events: auto` and act as native HTML5 drop targets. We
 * intentionally avoid `<dialog>.showModal()` because the modal mode would
 * capture the drag and route it to the dialog element instead of the
 * folder tiles beneath it.
 *
 * The overlay mounts/unmounts in response to document-level `dragstart` /
 * `dragend` events filtered by the `text/x-bookmark-id` MIME type — any
 * bookmark card on the page triggers this overlay, not just one.
 */
export function DragFolderOverlay({
  open,
  bookmarkTitle,
  onDrop,
  onCancel,
}: {
  open: boolean;
  bookmarkTitle: string;
  onDrop: (folderId: string) => void;
  onCancel: () => void;
}) {
  const folders = useBookmarkFolders();
  const [overId, setOverId] = useState<string | null>(null);

  // Reset the "hovered folder" tracker when the overlay re-opens (so a
  // second drag doesn't inherit the visual state of the previous one).
  useEffect(() => {
    if (open) setOverId(null);
  }, [open]);

  // Escape cancels the drag the same way dropping outside does. The
  // browser also fires `dragend` with effect=none in this case, but
  // listening for the key explicitly gives instant feedback and works in
  // browsers that don't fire `dragend` reliably on Escape.
  useEffect(() => {
    if (!open) return;
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const allFolders = folders.data?.folders ?? [];
  const customFolders = allFolders.filter((f) => !f.isDefault);

  const handleDragOver = (event: DragEvent<HTMLLIElement>, folderId: string) => {
    if (!event.dataTransfer.types.includes('text/x-bookmark-id')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setOverId(folderId);
  };
  const handleDragLeave = (folderId: string) => {
    setOverId((current) => (current === folderId ? null : current));
  };
  const handleDrop = (event: DragEvent<HTMLLIElement>, folderId: string) => {
    if (!event.dataTransfer.types.includes('text/x-bookmark-id')) return;
    event.preventDefault();
    onDrop(folderId);
  };

  return createPortal(
    <div className="drag-folder-overlay" role="dialog" aria-label="Move bookmark to folder">
      <div className="drag-folder-overlay__chrome" aria-hidden="true">
        <p className="drag-folder-overlay__hint">
          Drop on a folder to move
          <span className="drag-folder-overlay__title">“{bookmarkTitle}”</span>
        </p>
      </div>
      <ul className="drag-folder-overlay__list" aria-label="Folders">
        {customFolders.map((folder) => {
          const isOver = overId === folder.id;
          return (
            <li
              key={folder.id}
              className={`drag-folder-overlay__target${
                isOver ? ' drag-folder-overlay__target--over' : ''
              }`}
              onDragOver={(e) => handleDragOver(e, folder.id)}
              onDragEnter={(e) => handleDragOver(e, folder.id)}
              onDragLeave={() => handleDragLeave(folder.id)}
              onDrop={(e) => handleDrop(e, folder.id)}
            >
              <IconFolder size={20} />
              <span className="drag-folder-overlay__name">{folder.name}</span>
            </li>
          );
        })}
      </ul>

    </div>,
    document.body,
  );
}
