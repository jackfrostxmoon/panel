import { useSourceImageHealth } from '../api/hooks';
import { sourceLabel } from '../utils/format';
import { IconAlert } from './icons';

/**
 * Minimum recent image errors (without an allowlist block) before calling
 * a source out. A single transient blip (one 504, one timeout) must not
 * banner; allowlist blocks always banner — they are the certain signal of
 * a CDN move rather than a sick host.
 */
const ERROR_THRESHOLD = 3;

/**
 * Site-wide source-health banner. Polls `/api/health/detailed` in the
 * background and names any enabled source whose images are currently
 * failing — either blocked by the image allowlist (the source moved its
 * image CDN) or repeatedly erroring (a sick host). Renders nothing when
 * every source is healthy (or before the first poll resolves), and clears
 * itself as the server's rolling window ages out.
 */
export function SourceHealthBanner() {
  const health = useSourceImageHealth();
  if (!health.data) return null;

  const moved = health.data.sources.filter((s) => s.enabled && s.imageBlocked > 0);
  const failing = health.data.sources.filter(
    (s) => s.enabled && s.imageBlocked === 0 && s.imageErrors >= ERROR_THRESHOLD,
  );
  if (moved.length === 0 && failing.length === 0) return null;

  const parts: string[] = [];
  if (moved.length > 0) {
    const names = moved.map((s) => sourceLabel(s.name)).join(', ');
    parts.push(`${names} may have moved its image server — covers and pages can fail until the app is updated.`);
  }
  if (failing.length > 0) {
    const names = failing.map((s) => sourceLabel(s.name)).join(', ');
    parts.push(`Images from ${names} are failing to load — the source may be down.`);
  }

  return (
    <div className="source-health-banner" role="status">
      <span className="source-health-banner__icon" aria-hidden="true">
        <IconAlert size={16} />
      </span>
      <p className="source-health-banner__text">{parts.join(' ')}</p>
    </div>
  );
}
