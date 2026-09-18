import type { Chapter } from '@panel/shared';
import { IconDownload, IconStop } from './icons';

interface ChapterDownloadButtonProps {
  chapter: Chapter;
  /** True while this specific chapter is currently being downloaded. */
  isActive: boolean;
  /** True when the chapter finished and all pages are in the cache. */
  isDone: boolean;
  /** True when the chapter's download was cancelled mid-flight. */
  isCancelled: boolean;
  /** True when the chapter's download failed (any attempted page failed). */
  isFailed: boolean;
  /**
   * "X / Y pages" — for the live progress text on the icon's tooltip.
   * `X` is the count of pages ATTEMPTED in the current run when active;
   * when idle, `X` is the total number of pages confirmed cached (skipped
   * + freshly fetched) and `Y` is the chapter's page count, so the user
   * can see at a glance whether a chapter is fully cached.
   */
  progressLabel: string | null;
  /** Fired when the user clicks the icon. Stop variant fires instead when active. */
  onDownload: () => void;
  onCancel: () => void;
}

/**
 * Per-chapter download button — appears on hover/focus next to the
 * chapter title, mirroring `ChapterBookmarkButton`. Clicking pre-warms
 * the chapter's image cache; while in flight it becomes a stop button.
 *
 * Visibility (mirrors the bookmark button):
 *  - States that NEED user attention — active (in flight, must be stoppable),
 *    failed, cancelled — stay visible so the user can see and act on them
 *    without hovering. Marked with `--action` in CSS.
 *  - Pure-information states — done / idle — fade in only on row hover or
 *    keyboard focus, so a fully-cached chapter doesn't fill the list with
 *    green ticks. Same hover-only affordance as the bookmark star.
 *
 * The download state lives in the parent's `useChapterDownloader` so the
 * row only consumes the bits it cares about (active, done, progress).
 */
export function ChapterDownloadButton({
  isActive,
  isDone,
  isCancelled,
  isFailed,
  progressLabel,
  onDownload,
  onCancel,
}: ChapterDownloadButtonProps) {
  // `--action` = needs user attention. Anything the user must be able to
  // see (and act on) without hunting for it on hover: the stop button
  // while downloading, and the retry cue when a previous run was partial
  // or cancelled. `--done` is independent — it tints the idle icon violet
  // to signal "fully cached" once it appears on hover.
  const needsAction = isActive || isFailed || isCancelled;
  // Visual state precedence: running → cancelled/failed → done → idle.
  // Each idle label reads as "X / Y pages" (via progressLabel) when the
  // caller provides one, so a partial download is obvious on hover
  // ("12 / 37 pages — re-download" instead of a green "Done").
  const suffix = progressLabel ? ` (${progressLabel})` : '';
  const label = isActive
    ? `Stop downloading${suffix}`
    : isFailed
      ? `Download failed — retry${suffix}`
      : isCancelled
        ? `Download cancelled — retry${suffix}`
        : isDone
          ? `Already cached${suffix} — re-download`
          : `Download chapter (pre-warm cache)${suffix}`;

  return (
    <button
      type="button"
      className={`btn btn--ghost btn--icon-only chapter-download-btn${needsAction ? ' chapter-download-btn--action' : ''}${isActive ? ' chapter-download-btn--active' : ''}${isDone ? ' chapter-download-btn--done' : ''}`}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        if (isActive) onCancel();
        else onDownload();
      }}
    >
      <span aria-hidden="true" className="chapter-download-btn__icon">
        {isActive ? <IconStop size={16} /> : <IconDownload size={16} />}
      </span>
    </button>
  );
}