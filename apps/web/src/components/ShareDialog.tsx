import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, storedAccessToken } from '../api/client';
import { IconCheck, IconX } from './icons';

/** Hostnames that only work on the machine running the app itself. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Append the LAN access token to `url` when the device holds one, so the
 * share link/QR pairs another device in one tap (the target app claims
 * `?token=` on load — see `claimTokenFromUrl` in api/client). No token
 * stored (host PC) → the URL passes through unchanged.
 */
function withShareToken(url: string): string {
  const token = storedAccessToken();
  if (!token) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('token', token);
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Replace a loopback hostname in `url` with the server's LAN IP so the
 * link/QR code also works from other devices on the network. Falls back to
 * the original URL if the LAN address can't be resolved.
 */
function useShareUrl(url: string): string {
  const [shareUrl, setShareUrl] = useState(() => withShareToken(url));
  useEffect(() => {
    let alive = true;
    const tokened = withShareToken(url);
    setShareUrl(tokened);
    try {
      const parsed = new URL(tokened);
      if (!LOCAL_HOSTS.has(parsed.hostname)) return;
      api
        .getHealth()
        .then((info) => {
          if (!alive || !info.lanAddress) return;
          parsed.hostname = info.lanAddress;
          setShareUrl(parsed.toString());
        })
        .catch(() => {
          // Best-effort — keep the original URL.
        });
    } catch {
      // Not a parseable URL — keep as-is.
    }
    return () => {
      alive = false;
    };
  }, [url]);
  return shareUrl;
}

/**
 * Share dialog: shows a QR code of the current page plus the link itself,
 * with a copy-to-clipboard button. Closes on backdrop click, the ✕ button
 * or the Escape key.
 */
export function ShareDialog({
  title,
  url,
  onClose,
}: {
  title: string;
  url: string;
  onClose: () => void;
}) {
  const shareUrl = useShareUrl(url);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  // Render the QR code off the shareable URL.
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(shareUrl, {
      width: 256,
      margin: 2,
      color: { dark: '#1a1a1aff', light: '#ffffffff' },
    })
      .then((data) => {
        if (alive) setQrDataUrl(data);
      })
      .catch(() => {
        if (alive) setQrFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [shareUrl]);

  // Escape closes the dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copyLink = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (e.g. insecure context) — the link is still visible.
    }
  };

  return (
    <div
      className="share-dialog__overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="share-dialog" role="dialog" aria-modal="true" aria-label={`Share ${title}`}>
        <div className="share-dialog__head">
          <h2 className="share-dialog__title">Share</h2>
          <button
            type="button"
            className="share-dialog__close"
            aria-label="Close share dialog"
            onClick={onClose}
          >
            <IconX size={16} />
          </button>
        </div>

        <div className="share-dialog__qr">
          {qrDataUrl ? (
            <img src={qrDataUrl} alt={`QR code linking to ${title}`} width={200} height={200} />
          ) : qrFailed ? (
            <div className="share-dialog__qr-fallback">Could not generate QR code</div>
          ) : (
            <div className="share-dialog__qr-fallback" aria-hidden="true" />
          )}
        </div>
        <p className="share-dialog__hint">Scan to open on another device</p>

        <div className="share-dialog__link-row">
          <input
            type="text"
            className="share-dialog__link"
            value={shareUrl}
            readOnly
            onFocus={(event) => event.currentTarget.select()}
            aria-label="Panel link"
          />
          <button
            type="button"
            className={`btn btn--ghost btn--sm${copied ? ' share-dialog__copy--done' : ''}`}
            onClick={() => void copyLink(shareUrl)}
          >
            {copied ? (
              <>
                <IconCheck size={14} /> Copied
              </>
            ) : (
              'Copy link'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
