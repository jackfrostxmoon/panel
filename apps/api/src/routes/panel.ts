import { Hono } from 'hono';
import { ErrorCodes, isGlobalId, ok } from '@panel/shared';
import { AppError } from '../lib/errors.js';
import type { PanelService } from '../services/panelService.js';
import type { SourceRegistry } from '../sources/registry.js';

/**
 * Source-backed panel endpoints. All ids are global ("mk:...") — the service
 * routes them to the right source adapter.
 */
export function panelRoutes(panelService: PanelService, registry: SourceRegistry): Hono {
  const app = new Hono();

  /**
   * ?source=mk / ?source=mk,nk — comma-separated prefixes restricting which
   * sources are queried. Unknown prefixes are a client error.
   * Absent → the first enabled source only (never a fan-out to all sites).
   */
  function parseSourceFilter(raw: string | undefined): string[] | undefined {
    if (!raw) return undefined;
    const codes = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const known = new Set(registry.list().map((s) => s.name));
    const unknown = codes.filter((c) => !known.has(c));
    if (unknown.length > 0) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `Unknown source: ${unknown.join(', ')}. Known sources: ${[...known].join(', ')}.`,
        { sources: unknown },
      );
    }
    return codes;
  }

  /**
   * Genre label list from repeated (`?genre=a&genre=b`) and/or
   * comma-separated (`?genre=a,b`) params. Each label is trimmed and
   * capped; the list is capped at 20 entries (abuse guard). Undefined
   * when no usable label was given.
   */
  function trimParamList(raw: string[] | undefined, max: number): string[] | undefined {
    if (!raw) return undefined;
    const out: string[] = [];
    for (const entry of raw) {
      for (const part of entry.split(',')) {
        const value = part.trim();
        if (!value) continue;
        out.push(value.length > max ? value.slice(0, max) : value);
        if (out.length >= 20) return out;
      }
    }
    return out.length > 0 ? out : undefined;
  }

  // GET /api/panel/search?q=naruto&page=1&source=mk,nk&genre=Action&exclude=Hentai&mode=author
  // mode: "title" (default) | "author" | "artist" (server-side credit search
  // where the source supports it; the local metadata cache is merged in).
  // genre/exclude accept repeated (?genre=a&genre=b) and comma-separated
  // (?genre=a,b) forms; include semantics are OR.
  app.get('/search', async (c) => {
    const query = c.req.query('q')?.trim();
    if (!query) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Missing required query parameter "q".');
    }
    if (query.length > 200) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Search query is too long (max 200 chars).');
    }
    const pageRaw = Number.parseInt(c.req.query('page') ?? '1', 10);
    const page = Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1;

    // Genre constraints (display labels from the filter dropdowns). Combo-
    // capable sources filter server-side; the rest fall back to the plain
    // search with client-side narrowing.
    const modeRaw = c.req.query('mode');
    if (modeRaw !== undefined && modeRaw !== 'title' && modeRaw !== 'author' && modeRaw !== 'artist') {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Parameter "mode" must be one of "title", "author", "artist".');
    }
    const mode: 'title' | 'author' | 'artist' =
      modeRaw === 'author' || modeRaw === 'artist' ? modeRaw : 'title';
    const genres = trimParamList(c.req.queries('genre'), 100);
    const excludedGenres = trimParamList(c.req.queries('exclude'), 100);
    const result = await panelService.search(
      query,
      page,
      parseSourceFilter(c.req.query('source')),
      genres,
      excludedGenres,
      mode,
    );
    return c.json(ok(result));
  });

  // GET /api/panel/latest?page=1&source=mk,nk&genre=Action&exclude=Hentai
  // genre/exclude accept repeated (?genre=a&genre=b) and comma-separated
  // (?genre=a,b) forms; include semantics are OR.
  app.get('/latest', async (c) => {    const pageRaw = Number.parseInt(c.req.query('page') ?? '1', 10);
    const page = Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1;

    // Genre constraints (display labels from the filter dropdowns). When
    // the queried source filters server-side the whole catalog is
    // searched; otherwise the UI narrows the returned page client-side.
    const genres = trimParamList(c.req.queries('genre'), 100);
    const excludedGenres = trimParamList(c.req.queries('exclude'), 100);
    return c.json(
      ok(await panelService.latest(page, parseSourceFilter(c.req.query('source')), genres, excludedGenres)),
    );
  });

  // GET /api/panel/resolve?url=https://hiperdex.com/manga/<slug>
  // Maps a pasted source url to the global panel id (must be registered
  // before /:id, which would otherwise swallow "resolve").
  app.get('/resolve', async (c) => {
    const raw = c.req.query('url')?.trim() ?? '';
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Parameter "url" must be an absolute URL.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Only http(s) URLs are supported.');
    }
    return c.json(ok(panelService.resolveUrl(raw)));
  });

  // GET /api/panel/genres?source=nk
  // Full genre catalog for one source's filter dropdowns. Must be
  // registered before /:id, which would otherwise swallow "genres".
  app.get('/genres', async (c) => {
    const raw = c.req.query('source')?.trim() ?? '';
    if (!raw) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Missing required query parameter "source".');
    }
    const sources = parseSourceFilter(raw);
    const source = sources?.[0];
    if (!source) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Missing required query parameter "source".');
    }
    return c.json(ok({ source, genres: await panelService.getGenreList(source) }));
  });

  // GET /api/panel/:id
  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    if (!isGlobalId(id)) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Malformed panel id.', { id });
    }
    return c.json(ok(await panelService.getPanel(id)));
  });

  // GET /api/panel/:id/chapters
  app.get('/:id/chapters', async (c) => {
    const id = c.req.param('id');
    if (!isGlobalId(id)) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Malformed panel id.', { id });
    }
    return c.json(ok(await panelService.getChapters(id)));
  });

  return app;
}
