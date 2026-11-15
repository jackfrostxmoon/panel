import { useState } from 'react';
import { createPortal } from 'react-dom';
import { IconZoomIn } from './icons';
import { CoverLightbox } from './CoverLightbox';
import { getProxiedImageUrl } from '../utils/format';

/**
 * Cover-zoom button for cards (panel grid cards, bookmark cards) — same
 * role as the details-page hero zoom button: opens the cover in the
 * full-viewport interactive lightbox. Self-contained (own open state,
 * portal to <body> so it escapes the card's `overflow: hidden`), so it can
 * be dropped in next to the cover-clear button with one line.
 *
 * Rendered as a sibling of the card's stretched link / cover link, so the
 * click never navigates. `--below-status` pushes it under the status pill
 * when card badges are shown; callers opt in like `cover-clear--below-source`.
 */
export function CoverZoomButton({
  source,
  coverUrl,
  panelId,
  title,
  belowStatus,
  cacheNonce,
  className,
}: {
  source: string;
  coverUrl: string | null;
  panelId: string;
  title: string;
  /** Push the button below the top-left status badge (badges visible). */
  belowStatus?: boolean;
  /** Bumped after a cache-clear to bust the browser's immutable max-age. */
  cacheNonce?: number;
  /** Extra class for callers with their own reveal rules (e.g. bookmark card). */
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  const proxied = getProxiedImageUrl(source, coverUrl, 'cover', panelId);
  const src =
    proxied && cacheNonce !== undefined && cacheNonce > 0
      ? `${proxied}${proxied.includes('?') ? '&' : '?'}_retry=${cacheNonce}`
      : proxied;

  return (
    <>
      <button
        type="button"
        className={`panel-card__cover-zoom${belowStatus ? ' panel-card__cover-zoom--below-status' : ''}${className ? ` ${className}` : ''}`}
        onClick={() => setOpen(true)}
        disabled={!coverUrl}
        aria-label="View cover image full screen"
        title="View cover image full screen"
      >
        <IconZoomIn size={15} />
      </button>
      {open &&
        src &&
        createPortal(
          <CoverLightbox title={title} src={src} onClose={() => setOpen(false)} />,
          document.body,
        )}
    </>
  );
}
