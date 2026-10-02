import type { Chapter } from '@panel/shared';
import { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { sortChaptersForDownload, type ChapterOrder } from '../download/order';
import { chapterLabel } from '../utils/format';

/**
 * Direction prompt shown before any bulk chapter download starts.
 *
 * Built on the native `<dialog>` element (focus trap + Esc handling for free)
 * and rendered through a portal, mirroring `ConfirmDialog`. It differs in one
 * way: there is no single confirm action, because the two buttons ARE the
 * choice — "start from chapter 1" versus "start from the latest chapter".
 * Neither is destructive, so neither is styled as the danger action.
 *
 * The message names the actual endpoint chapters so the direction reads
 * unambiguously even when the chapter titles are raw source tokens.
 */
export function ChapterOrderDialog({
  open,
  /** How many chapters the batch will contain. */
  count,
  /** Label for the trigger, e.g. `all` / `unread` / `selected`. */
  batchLabel,
  /** The batch as it would download if nothing were sorted. */
  chapters,
  onPick,
  onCancel,
}: {
  open: boolean;
  count: number;
  /** Noun for the batch in the title, e.g. `chapters` / `unread chapters`. */
  batchLabel: string;
  /** Used only to name the first/last chapter in the button copy. */
  chapters: readonly Chapter[];
  onPick: (order: ChapterOrder) => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Name the real endpoint each button will actually start from, derived from
  // the sorted order rather than the incoming array: the caller hands us the
  // display-ordered list, so `chapters[0]` is not necessarily chapter 1 and
  // labelling it that way would contradict the sort the button performs.
  const ascending = useMemo(
    () => sortChaptersForDownload(chapters, 'oldest-first'),
    [chapters],
  );
  const descending = useMemo(
    () => sortChaptersForDownload(chapters, 'newest-first'),
    [chapters],
  );
  const ascendingFirst = ascending[0];
  const descendingFirst = descending[0];

  return createPortal(
    <dialog
      ref={dialogRef}
      className="dialog"
      aria-labelledby="chapter-order-dialog-title"
      onClose={onCancel}
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === dialogRef.current) onCancel();
      }}
    >
      <div className="dialog__body">
        <h2 id="chapter-order-dialog-title" className="dialog__title">
          Download {count} {batchLabel}
        </h2>
        <p className="dialog__message">
          Which direction should this batch download in? Chapters are cached in the order you
          pick.
        </p>
        <div className="dialog__actions dialog__actions--stack">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => onPick('oldest-first')}
            autoFocus
            title={
              ascendingFirst
                ? `Start with ${chapterLabel(ascendingFirst.chapterNumber, ascendingFirst.title)} and work forward`
                : 'Start with the first chapter and work forward'
            }
          >
            Oldest → Newest
          </button>
          <span className="chapter-order-dialog__hint">
            {ascendingFirst
              ? `Starts at ${chapterLabel(ascendingFirst.chapterNumber, ascendingFirst.title)}`
              : 'Starts at the first chapter in the list'}
          </span>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => onPick('newest-first')}
            title={
              descendingFirst
                ? `Start with ${chapterLabel(descendingFirst.chapterNumber, descendingFirst.title)} and work back`
                : 'Start with the latest chapter and work back'
            }
          >
            Newest → Oldest
          </button>
          <span className="chapter-order-dialog__hint">
            {descendingFirst
              ? `Starts at ${chapterLabel(descendingFirst.chapterNumber, descendingFirst.title)}`
              : 'Starts at the last chapter in the list'}
          </span>
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}