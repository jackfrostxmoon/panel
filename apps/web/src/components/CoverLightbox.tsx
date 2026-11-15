import { useEffect, useRef } from 'react';
import { IconX } from './icons';

/**
 * Full-viewport lightbox for the details-page cover image. Closes on the
 * backdrop, the ✕ button, or Escape. The image is shown at its natural
 * aspect ratio bounded by the viewport — the proxied cover URL is the only
 * resolution we have, so this is a "view it properly" zoom rather than a
 * true higher-res fetch.
 */
export function CoverLightbox({
  title,
  src,
  onClose,
}: {
  title: string;
  src: string;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Move focus into the dialog on open, close on Escape.
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="cover-lightbox__overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="cover-lightbox"
        role="dialog"
        aria-modal="true"
        aria-label={`Cover image for ${title}`}
      >
        <button
          ref={closeRef}
          type="button"
          className="cover-lightbox__close"
          aria-label="Close cover view"
          onClick={onClose}
        >
          <IconX size={18} />
        </button>
        <img
          src={src}
          alt={`Cover of ${title}`}
          className="cover-lightbox__img"
        />
      </div>
    </div>
  );
}
