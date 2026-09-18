import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

/**
 * Accessible confirmation dialog built on the native <dialog> element
 * (focus trapping + Esc handling come for free). Rendered through a portal
 * so it can live anywhere in the tree (even inside links) without inheriting
 * layout context, and clicks never reach surrounding interactive parents.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
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
      aria-labelledby="confirm-dialog-title"
      onClose={onCancel}
      onClick={(e) => {
        // Keep dialog clicks from bubbling up the React tree — otherwise an
        // ancestor <Link> (chapter rows, cards) would navigate on close.
        e.stopPropagation();
        // Backdrop click closes.
        if (e.target === dialogRef.current) onCancel();
      }}
    >
      <div className="dialog__body">
        <h2 id="confirm-dialog-title" className="dialog__title">
          {title}
        </h2>
        <p className="dialog__message">{message}</p>
        <div className="dialog__actions">
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
