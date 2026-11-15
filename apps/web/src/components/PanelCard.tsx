import { useState, type MouseEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { PanelSummary } from '@panel/shared';
import { IconBookmark, IconFolder, IconTrash } from './icons';
import { formatBytes, sourceLabel } from '../utils/format';
import { CoverImage } from './CoverImage';
import { CoverZoomButton } from './CoverZoomButton';
import { useClearImageCacheByTag } from '../api/hooks';
import { useToast } from './Toast';

/** Joined reading progress (matches the shape on Bookmark.progress). */
export interface PanelCardProgress {
  chapterId: string;
  chapterTitle: string | null;
}

/**
 * Panel cover card used in grids (search results, latest updates,
 * continue reading). Lazy-loads its cover and falls back to a styled
 * placeholder.
 *
 * The whole card is the click target for opening the details page,
 * achieved via a stretched <Link> overlay so action buttons can sit
 * inside the card without nesting interactive elements. When the
 * caller passes `actions`, the strip is revealed on hover (or always on
 * touch devices) — same pattern as the bookmarks grid. Callers
 * typically render Continue/Folder/Open/Remove in the strip.
 */
export function PanelCard({
  panel,
  footer,
  from,
  bookmarked,
  progress,
  hideBookmarkBadge,
  hideBadges,
  actions,
  onContinue,
  folderNames,
}: {
  panel: Pick<
    PanelSummary,
    'id' | 'title' | 'coverUrl' | 'status' | 'latestChapter' | 'source'
  > &
    Partial<Pick<PanelSummary, 'genres' | 'summary'>>;
  footer?: ReactNode;
  /** Section the card is shown in, so the details page can render a breadcrumb trail. */
  from?: string;
  /** Highlight the card when this panel is already bookmarked. */
  bookmarked?: boolean;
  /** Reading progress — surfaces a "Last: Ch. X" meta line. */
  progress?: PanelCardProgress | null;
  /** Hide the corner bookmark glyph. Useful on Latest where the action
   *  strip already exposes Remove from Bookmarks. */
  hideBookmarkBadge?: boolean;
  /** Hide ALL cover overlays (status badge, source label, bookmark glyph,
   *  folder pills) at once. Takes precedence over `hideBookmarkBadge`. */
  hideBadges?: boolean;
  /** Optional action strip rendered over the cover on hover. The caller
   *  is responsible for stopping click propagation on its buttons. */
  actions?: ReactNode;
  /** Called when the user clicks the standalone Continue button. When
   *  provided, the Continue button is rendered above the title; useful
   *  for callers that don't supply an `actions` strip. */
  onContinue?: (progress: PanelCardProgress) => void;
/** Folder names the bookmark lives in. Rendered as folder pills under
   *  the meta line — same treatment as the bookmarks grid card. */
  folderNames?: string[];
}) {
  const navigate = useNavigate();
  const to = from
    ? `/panel/${encodeURIComponent(panel.id)}?from=${encodeURIComponent(from)}`
    : `/panel/${encodeURIComponent(panel.id)}`;
  const { toast } = useToast();
  const clearCoverMutation = useClearImageCacheByTag();
  /** Bumped after clearing the cached cover so the browser's immutable
   *  max-age on the proxied URL is busted and it refetches fresh. */
  const [coverNonce, setCoverNonce] = useState(0);

  // Delete the cached cover so a wrong/stale image gets refetched. The
  // nonce busts the browser's immutable max-age on the proxied URL.
  const handleClearCover = () => {
    clearCoverMutation.mutate(
      { what: 'cover', tag: panel.id },
      {
        onSuccess: (result) => {
          setCoverNonce((n) => n + 1);
          toast(
            `Cleared ${result.entryCount.toLocaleString()} cached cover file${result.entryCount === 1 ? '' : 's'} (${formatBytes(result.totalBytes)}) — refetching.`,
            'success',
          );
        },
        onError: (error) =>
          toast(error instanceof Error ? error.message : 'Could not clear the cover cache.', 'error'),
      },
    );
  };

  const progressFooter = progress
    ? (progress.chapterTitle ?? 'Chapter')
    : null;

  const handleContinue = (e: MouseEvent<HTMLButtonElement>) => {
    if (!progress) return;
    e.preventDefault();
    e.stopPropagation();
    if (onContinue) onContinue(progress);
    else navigate(`/read/${encodeURIComponent(progress.chapterId)}`);
  };

  return (
    <article
      className={`panel-card${bookmarked ? ' panel-card--bookmarked' : ''}${
        progress ? ' panel-card--in-progress' : ''
      }${actions ? ' panel-card--has-actions' : ''}`}
    >
      <div className="panel-card__cover">
        <CoverImage
          source={panel.source}
          coverUrl={panel.coverUrl}
          panelId={panel.id}
          title={panel.title}
          cacheNonce={coverNonce}
        />
        {hideBadges ? null : panel.status !== 'unknown' && (
          <span className={`panel-card__status panel-card__status--${panel.status}`}>
            {panel.status}
          </span>
        )}
        {hideBadges ? null : (
          <span className="panel-card__source" title={`Source: ${sourceLabel(panel.source)}`}>
            {sourceLabel(panel.source)}
          </span>
        )}
        {hideBadges ? null : bookmarked && !hideBookmarkBadge && (
          <span
            className="panel-card__bookmark-badge"
            title="Bookmarked"
            aria-label="Bookmarked"
          >
            <IconBookmark size={14} filled />
          </span>
        )}
        {hideBadges ? null : folderNames && folderNames.length > 0 && (
          <ul
            className="panel-card__folders"
            aria-label={`Folders: ${folderNames.join(', ')}`}
          >
            {folderNames.slice(0, 3).map((name) => (
              <li key={name} className="panel-card__folder-pill" title={name}>
                <IconFolder size={11} />
                <span>{name}</span>
              </li>
            ))}
            {folderNames.length > 3 && (
              <li className="panel-card__folder-pill panel-card__folder-pill--more">
                +{folderNames.length - 3}
              </li>
            )}
          </ul>
        )}
        {/* Cover-zoom: opens the cover in the interactive lightbox.
            Rendered on the LEFT — opposite the trash — below the status pill
            when badges show it. Sits above the stretched link like the
            trash so the click never navigates. */}
        <CoverZoomButton
          source={panel.source}
          coverUrl={panel.coverUrl}
          panelId={panel.id}
          title={panel.title}
          belowStatus={!hideBadges}
          cacheNonce={coverNonce}
        />
        {/* Cover-clear: delete the cached cover so a wrong/stale image
            refetches (same action as the details-page hero trash button).
            Rendered after the badges so CSS can offset it below the
            source pill when badges are shown. */}
        <button
          type="button"
          className={`panel-card__cover-clear${hideBadges ? '' : ' panel-card__cover-clear--below-source'}`}
          onClick={handleClearCover}
          disabled={clearCoverMutation.isPending || !panel.coverUrl}
          aria-label="Delete cached cover image and refetch"
          title="Delete cached cover image and refetch"
        >
          <IconTrash size={15} />
        </button>
        {actions && <div className="panel-card__actions">{actions}</div>}
        {/* Stretched link covers the card so a click anywhere opens the
            details page. Sits below the action strip in z-order. */}
        <Link
          to={to}
          className="panel-card__stretched"
          aria-label={`Open ${panel.title}`}
        />
      </div>
      <div className="panel-card__body">
        <h3 className="panel-card__title">
          <Link to={to} className="panel-card__title-link">
            {panel.title}
          </Link>
        </h3>
        {/* Reading progress: "Chapter X" — same shape as the
            bookmarks grid card. When progress is set, also show the
            source's latest chapter underneath so the user can see how
            far behind they are at a glance. */}
        {progress && (
          <>
            <p className="panel-card__meta panel-card__meta--progress">
              {progressFooter}
            </p>
            {panel.latestChapter && (
              <p className="panel-card__meta panel-card__meta--latest">
                Latest · {panel.latestChapter}
              </p>
            )}
          </>
        )}
        {!progress && panel.latestChapter && (
          <p className="panel-card__meta">{panel.latestChapter}</p>
        )}
        {footer}
      </div>
      {/* Standalone Continue button — only when the caller didn't supply
          its own action strip. Sits at the bottom of the card body so it
          stays reachable for keyboards and touch. */}
      {progress && onContinue && !actions && (
        <button
          type="button"
          className="panel-card__continue"
          aria-label={`Continue reading at ${progress.chapterTitle ?? 'last chapter'}`}
          onClick={handleContinue}
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
        </button>
      )}
    </article>
  );
}

/** Grid of panel cards with a shared responsive layout. */
export function PanelGrid({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={className ? `panel-grid ${className}` : 'panel-grid'}>{children}</div>;
}
