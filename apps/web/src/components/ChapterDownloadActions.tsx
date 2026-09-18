import { useCallback, useId, useState } from 'react';
import type { Chapter } from '@panel/shared';
import { useToast } from './Toast';
import { ConfirmDialog } from './ConfirmDialog';
import { IconDownload, IconStop } from './icons';
import type { ChapterDownloader } from '../hooks/useChapterDownloader';
import {
  CHAPTER_INTERVAL_PRESETS,
  clampDownloadInterval,
  DOWNLOAD_INTERVAL_MAX_MS,
  DOWNLOAD_INTERVAL_MIN_MS,
  DOWNLOAD_INTERVAL_STEP_MS,
  type DownloadSettings,
} from '../download/settings';

/**
 * Format a millisecond count as `m:ss` for the inter-chapter wait
 * countdown (e.g. `2:00`, `0:45`, `10:00`). Always shows two digits of
 * seconds so the countdown doesn't visibly jump width as it ticks.
 */
function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

interface ChapterDownloadActionsProps {
  panelId: string;
  /** All chapters (used by the "Download all" / "Download unread" buttons). */
  chapters: Chapter[];
  /** Chapters the user has started (drives the "Download unread" button). */
  readChapterIds?: Set<string>;
  /** Live download state from the parent's `useChapterDownloader`. */
  downloader: ChapterDownloader;
  /** Pacing settings owned by the parent; surfaced inline so the user
   *  can tune the wait between chapters without leaving the panel page. */
  downloadSettings: DownloadSettings;
  /** Patches the parent's download settings. */
  onDownloadSettingsChange: (patch: Partial<DownloadSettings>) => void;
}

/**
 * Bulk download panel — sits inside the panel-details page's existing
 * "Actions" toggle next to the chapter list. Mirrors
 * `ChapterBookmarkActions`'s shape so the two panels feel like siblings.
 *
 * Buttons:
 *  - "Download all (N)"    — pre-warm every matching chapter.
 *  - "Download unread (N)" — filter to chapters the user hasn't opened.
 *  - "Stop downloads"      — abort the in-flight batch.
 *
 * Bulk buttons render locked when the user has the reader's data-saver
 * mode on — too easy to spend their data bundle otherwise. Single-chapter
 * download buttons (the row + context-menu variants) bypass this gate;
 * the user is making an explicit choice.
 */
export function ChapterDownloadActions({
  chapters,
  readChapterIds,
  downloader,
  downloadSettings,
  onDownloadSettingsChange,
}: ChapterDownloadActionsProps) {
  const { toast } = useToast();
  const [confirmStop, setConfirmStop] = useState(false);

  const allChapters = chapters;
  const unreadChapters = readChapterIds
    ? allChapters.filter((c) => !readChapterIds.has(c.id))
    : allChapters;

  const isBusy = downloader.isDownloading;

  /** Common entry-point — runs a batch and surfaces a single result toast. */
  const runBatch = useCallback(
    async (label: string, batch: Chapter[]) => {
      if (batch.length === 0) {
        toast('No chapters to download', 'info');
        return;
      }
      try {
        const result = await downloader.downloadChapters(batch, {
          chapterIntervalMs: downloadSettings.chapterIntervalMs,
        });
        if (result.cancelled) {
          toast(
            `Download stopped — ${result.done} ${label} cached so far.`,
            'info',
          );
        } else if (result.failed > 0) {
          toast(
            `Downloaded ${result.done} ${label} — ${result.failed} failed (some pages skipped).`,
            'success',
          );
        } else if (result.failedPages > 0) {
          toast(
            `Downloaded ${result.done} ${label}, but ${result.failedPages} page(s) failed — re-run the download to retry them.`,
            'info',
          );
        } else {
          toast(
            `Downloaded ${result.done} ${label}. They'll open instantly next time.`,
            'success',
          );
        }
      } catch (error) {
        toast(error instanceof Error ? error.message : 'Download failed.', 'error');
      }
    },
    [downloader, downloadSettings.chapterIntervalMs, toast],
  );

  const handleDownloadAll = () => {
    void runBatch(
      allChapters.length === 1 ? 'chapter' : 'chapters',
      allChapters,
    );
  };
  const handleDownloadUnread = () => {
    void runBatch(
      unreadChapters.length === 1 ? 'chapter' : 'chapters',
      unreadChapters,
    );
  };
  const handleStop = () => {
    downloader.cancel();
    setConfirmStop(false);
    toast('Downloads stopped. Pages already cached are kept.', 'info');
  };

  // Live progress line under the buttons. Three modes:
  //   - "Waiting X:XX before next chapter…" while the inter-chapter pause
  //     is in flight (takes priority so the user knows why nothing is
  //     happening on the per-chapter bar).
  //   - "Downloading — X / Y pages (chapter N of M)" while a chapter is
  //     actively fetching pages.
  //   - "Loading chapter…" while the chapter-pages payload is in flight.
  const waitingLine =
    downloader.intervalRemainingMs !== null && downloader.intervalRemainingMs > 0
      ? `Waiting ${formatCountdown(downloader.intervalRemainingMs)} before next chapter…`
      : null;
  const activeId = downloader.activeChapterIds[0];
  const activeProgress = activeId ? downloader.progress[activeId] : undefined;
  const downloadLine = activeProgress
    ? activeProgress.state === 'fetching-payload'
      ? 'Loading chapter…'
      : activeProgress.state === 'downloading'
        ? `Downloading — ${activeProgress.current} / ${activeProgress.total} pages (chapter ${
            downloader.doneCount + downloader.failedCount + 1
          } of ${downloader.activeChapterIds.length})`
        : null
    : null;
  const progressLine = waitingLine ?? downloadLine;

  // Whether the chosen interval matches one of the preset buttons. Drives
  // the segmented row's `aria-checked` state and the custom-number input's
  // highlighted state ("custom" appears when no preset matches).
  const activePresetValue = CHAPTER_INTERVAL_PRESETS.find(
    (p) => p.value === downloadSettings.chapterIntervalMs,
  )?.value;

  // Stable id for the segmented row's radiogroup labelling.
  const intervalGroupId = useId();

  return (
    <div className="chapter-download-actions" aria-label="Bulk chapter download actions">
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={handleDownloadAll}
        disabled={isBusy || allChapters.length === 0}
        aria-label={`Pre-warm image cache for all ${allChapters.length} matching chapters`}
        title="Download every matching chapter into the server's image cache"
      >
        <span aria-hidden="true">
          <IconDownload size={14} />
        </span>
        Download all ({allChapters.length})
      </button>

      {readChapterIds && unreadChapters.length !== allChapters.length && (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={handleDownloadUnread}
          disabled={isBusy || unreadChapters.length === 0}
          aria-label={`Pre-warm image cache for the ${unreadChapters.length} unread chapters`}
          title="Download every chapter you haven't read yet"
        >
          <span aria-hidden="true">
            <IconDownload size={14} />
          </span>
          Download unread ({unreadChapters.length})
        </button>
      )}

      {isBusy && (
        <button
          type="button"
          className="btn btn--ghost btn--sm chapter-download-actions__stop"
          onClick={() => setConfirmStop(true)}
          aria-label="Stop the in-flight download batch"
          title="Stop the in-flight download batch"
        >
          <span aria-hidden="true">
            <IconStop size={14} />
          </span>
          Stop downloads
        </button>
      )}

      {progressLine && (
        <p className="chapter-download-actions__progress" role="status" aria-live="polite">
          {progressLine}
        </p>
      )}

      <div
        className="download-settings"
        role="group"
        aria-labelledby={`${intervalGroupId}-label`}
      >
        <span id={`${intervalGroupId}-label`} className="download-settings__label">
          Wait between chapters
        </span>
        <div
          className="segmented download-settings__presets"
          role="radiogroup"
          aria-labelledby={`${intervalGroupId}-label`}
        >
          {CHAPTER_INTERVAL_PRESETS.map((preset) => {
            const active = preset.value === activePresetValue;
            return (
              <button
                key={preset.value}
                type="button"
                role="radio"
                aria-checked={active}
                className={`segmented__option${active ? ' segmented__option--active' : ''}`}
                onClick={() => onDownloadSettingsChange({ chapterIntervalMs: preset.value })}
              >
                <span>{preset.label}</span>
              </button>
            );
          })}
        </div>
        <label
          className={`download-settings__custom${activePresetValue === undefined ? ' download-settings__custom--active' : ''}`}
        >
          <span className="download-settings__custom-label">Custom (ms)</span>
          <input
            type="number"
            className="download-settings__custom-input"
            min={DOWNLOAD_INTERVAL_MIN_MS}
            max={DOWNLOAD_INTERVAL_MAX_MS}
            step={DOWNLOAD_INTERVAL_STEP_MS}
            inputMode="numeric"
            value={downloadSettings.chapterIntervalMs}
            onChange={(event) => {
              const raw = event.target.value;
              if (raw === '') {
                onDownloadSettingsChange({ chapterIntervalMs: 0 });
                return;
              }
              const parsed = Number(raw);
              if (Number.isNaN(parsed)) return;
              onDownloadSettingsChange({
                chapterIntervalMs: clampDownloadInterval(parsed),
              });
            }}
            aria-label="Custom wait between chapters in milliseconds"
          />
        </label>
        <p className="download-settings__help">
          Pauses between chapters so a bulk run doesn't hammer the upstream source. 0 = off
          (back-to-back). Stops immediately if you cancel mid-wait.
        </p>
      </div>

      <p className="chapter-download-actions__help">
        Pre-warms the server's image cache so chapters open instantly next time you read
        them. Cached pages count toward the on-disk cap — manage them on the{' '}
        <a href="/settings/cache" className="chapter-download-actions__link">Image cache</a> page.
      </p>

      <ConfirmDialog
        open={confirmStop}
        title="Stop downloads?"
        message="Pages already cached stay cached. The current chapter is cancelled mid-flight."
        confirmLabel="Stop"
        onConfirm={handleStop}
        onCancel={() => setConfirmStop(false)}
      />
    </div>
  );
}