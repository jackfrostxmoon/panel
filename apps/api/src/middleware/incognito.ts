import type { MiddlewareHandler } from 'hono';
import { ErrorCodes, fail } from '@panel/shared';

/**
 * Incognito gate — when the web client sends `X-Panel-Incognito: 1`,
 * user-data writes are refused at the edge. The UI already hides the
 * affordances (bookmarks, ratings, tags, reading list, progress writes
 * fall back to browser storage); this is the fail-closed backstop so a
 * stray mutation can never land in the database while the mode is on.
 *
 * Only mutating methods are affected. Reads (GET/HEAD/OPTIONS) pass
 * through, as do everything the app needs for a bare reading session:
 * metadata/image caches, downloads/prefetch, and settings preferences.
 */

/** Mount prefixes that own user data (writes are blocked in incognito). */
const USER_DATA_PREFIXES = [
  '/api/bookmarks',
  '/api/bookmark-folders',
  '/api/ratings',
  '/api/tags',
  '/api/chapter-bookmarks',
  '/api/progress',
  '/api/reading-list',
  '/api/recently-viewed',
  // Backup import rewrites user data — block its mutating methods too.
  '/api/backup',
];

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const incognitoGuard: MiddlewareHandler = async (c, next) => {
  if (c.req.header('x-panel-incognito') !== '1') return next();
  const method = c.req.method.toUpperCase();
  if (SAFE_METHODS.has(method)) return next();
  const path = c.req.path;
  const blocked = USER_DATA_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`),
  );
  if (!blocked) return next();
  return c.json(
    fail(ErrorCodes.INCOGNITO_MODE, 'Incognito mode is on — nothing is saved.'),
    403,
  );
};
