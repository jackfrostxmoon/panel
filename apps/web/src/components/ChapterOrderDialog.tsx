import type { Chapter } from '@panel/shared';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { sortChaptersForDownload, type ChapterOrder } from '../download/order';
import { chapterLabel } from '../utils/format';

/** Which chapters of the batch the direction buttons operate on. */
export type DownloadScope = 'all' | 'uncached-only';

/**
 * Direction prompt shown before any bulk chapter download starts.
 *
 * Built on the native `<dialog>` element (focus trap + Esc handling for free)
 * and rendered through a portal, mirroring `ConfirmDialog`. It differs in one
 * way: there is no single confirm action, because the two buttons ARE the
 * choice — "start from chapter 1" versus "start from the latest chapter".
 * Neither is destructive, so neither is styled as the danger action.
 *
 * When `isDone` is provided, a scope toggle renders above the direction
 * buttons (`All` vs `Uncached only`, with live counts) and the buttons
 * operate on the scoped list — the endpoint hints, title count, and the
 * batch handed to `onPick` all agree. The done-check is the same signal
 * as the per-row badges, so the popup count never contradicts the list.
 *
 * The message names the actual endpoint chapters so the direction reads
 * unambiguously even when the chapter titles are raw source tokens.
 */
export function ChapterOrderDialog({
  open,
  /** Noun for the batch in the title, e.g. `chapters` / `unread chapters`. */
  batchLabel,
  /** The batch as it would download if nothing were sorted or filtered. */
  chapters,
  /** Done-check powering the `Uncached only` scope. Omit to hide the toggle. */
  isDone,
  onPick,
  onCancel,
}: {
  open: boolean;
  /** Noun for the batch in the title, e.g. `chapters` / `unread chapters`. */
  batchLabel: string;
  /** Used to derive the scoped batch and to name the endpoint chapters. */
  chapters: readonly Chapter[];
  /** Done-check powering the `Uncached only` scope. Omit to hide the toggle. */
  isDone?: (chapterId: string) => boolean;
  onPick: (order: ChapterOrder, chapters: Chapter[]) => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [scope, setScope] = useState<DownloadScope>('all');
  const scopeGroupId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Reset the scope every time the dialog opens so a stale "uncached"
  // choice from a previous run never silently narrows the next batch.
  useEffect(() => {
    if (open) setScope('all');
  }, [open ]);

  const uncached = useMemo(
    () => (isDone ? chapters.filter((c) => !isDone(c.id)) : [...chapters]),
    [chapters, isDone],
  );
  const scoped: readonly Chapter[] = scope === 'uncached-only' && isDone ? uncached : chapters;

  // Name the real endpoint each button will actually start from, derived from
  // the sorted order rather than the incoming array: the caller hands us the
  // display-ordered list, so `chapters[0]` is not necessarily chapter 1 and
  // labelling it that way would contradict the sort the button performs.
  const ascending = useMemo(() => sortChaptersForDownload(scoped, 'oldest-first'), [scoped]);
  const descending = useMemo(() => sortChaptersForDownload(scoped, 'newest-first'), [scoped]);
  const ascendingFirst = ascending[0];
  const descendingFirst = descending[0];
  const empty = scoped.length === 0;

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
          Download {scoped.length} {batchLabel}
        </h2>
        <p className="dialog__message">
          Which direction should this batch download in? Chapters are cached in the order you
          pick.
        </p>
        {isDone && (
          <div
            className="segmented chapter-order-dialog__scope"
            role="radiogroup"
            aria-labelledby={`${scopeGroupId}-label`}
          >
            <span id={`${scopeGroupId}-label`} className="sr-only">
              Download scope
            </span>
            {(
              [
                { value: 'all', label: `All (${chapters.length})` },
                { value: 'uncached-only', label: `Uncached only (${uncached.length})` },
              ] as const
            ).map((option) => {
              const active = option.value === scope;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={`segmented__option${active ? ' segmented__option--active' : ''}`}
                  onClick={() => setScope(option.value)}
                >
                  <span>{option.label}</span>
                </button>
              );
            })}
          </div>
        )}
        <div className="dialog__actions dialog__actions--stack">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => onPick('oldest-first', ascending)}
            disabled={empty}
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
            {empty
              ? 'Everything in this batch is already cached.'
              : ascendingFirst
                ? `Starts at ${chapterLabel(ascendingFirst.chapterNumber, ascendingFirst.title)}`
                : 'Starts at the first chapter in the list'}
          </span>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => onPick('newest-first', descending)}
            disabled={empty}
            title={
              descendingFirst
                ? `Start with ${chapterLabel(descendingFirst.chapterNumber, descendingFirst.title)} and work back`
                : 'Start with the latest chapter and work back'
            }
          >
            Newest → Oldest
          </button>
          <span className="chapter-order-dialog__hint">
            {empty
              ? 'Switch back to All, or cancel.'
              : descendingFirst
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
