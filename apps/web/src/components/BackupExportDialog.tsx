import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { BackupExportScope } from '@panel/shared';

/**
 * Export-scope picker shown when the Bookmarks page Export action is
 * clicked. Rendered through a portal on the native <dialog> element (focus
 * trapping + Esc handling come for free), styled with the shared `.dialog`
 * classes so it matches ConfirmDialog/FolderPickerDialog.
 */
export function BackupExportDialog({
  open,
  exporting,
  onPick,
  onCancel,
}: {
  open: boolean;
  exporting: boolean;
  onPick: (scope: BackupExportScope) => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return createPortal(
    <dialog
      ref={dialogRef}
      className="dialog"
      aria-labelledby="export-dialog-title"
      onClose={onCancel}
      onClick={(e) => {
        e.stopPropagation();
        // Backdrop click closes.
        if (e.target === dialogRef.current) onCancel();
      }}
    >
      <div className="dialog__body">
        <h2 id="export-dialog-title" className="dialog__title">
          Export backup
        </h2>
        <p className="dialog__message">
          Both files restore through Import (.sql). Bookmarks-only skips the
          reader, search and prefetch caches, so it downloads much faster.
        </p>
        <div className="export-options">
          <button
            type="button"
            className="btn btn--ghost export-options__btn"
            disabled={exporting}
            onClick={() => onPick('full')}
          >
            <span className="btn-text">{exporting ? 'Exporting…' : 'Full backup (.sql)'}</span>
            <span className="btn-subtext">Everything, including caches. Largest file.</span>
          </button>
          <button
            type="button"
            className="btn btn--ghost export-options__btn"
            disabled={exporting}
            onClick={() => onPick('minimal')}
          >
            <span className="btn-text">{exporting ? 'Exporting…' : 'Bookmarks only (.sql)'}</span>
            <span className="btn-subtext">
              Bookmarks, folders, progress, lists, ratings, tags. No caches.
            </span>
          </button>
        </div>
        <div className="dialog__actions">
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
