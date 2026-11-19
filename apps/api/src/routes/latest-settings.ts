import { Hono } from 'hono';
import { ErrorCodes, ok, type CardLayout } from '@panel/shared';
import { AppError } from '../lib/errors.js';
import { loadLatestSettings, saveLatestSettings } from '../lib/latestSettingsFile.js';

export function latestSettingsRoutes(): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    return c.json(ok(loadLatestSettings()));
  });

  app.put('/', async (c) => {
    const body = (await c.req.json()) as unknown;
    if (
      !body ||
      typeof body !== 'object' ||
      typeof (body as { infiniteScroll?: unknown }).infiniteScroll !== 'boolean' ||
      !isCardLayout((body as { cardLayout?: unknown }).cardLayout) ||
      typeof (body as { filtersCollapsed?: unknown }).filtersCollapsed !== 'boolean' ||
      typeof (body as { searchOpen?: unknown }).searchOpen !== 'boolean' ||
      typeof (body as { matchAllGenres?: unknown }).matchAllGenres !== 'boolean'
    ) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Request body must be { infiniteScroll: boolean, cardLayout: "cards" | "list", filtersCollapsed: boolean, searchOpen: boolean, matchAllGenres: boolean }.',
      );
    }
    const typed = body as {
      infiniteScroll: boolean;
      cardLayout: CardLayout;
      filtersCollapsed: boolean;
      searchOpen: boolean;
      matchAllGenres: boolean;
    };
    return c.json(
      ok(
        saveLatestSettings({
          infiniteScroll: typed.infiniteScroll,
          cardLayout: typed.cardLayout,
          filtersCollapsed: typed.filtersCollapsed,
          searchOpen: typed.searchOpen,
          matchAllGenres: typed.matchAllGenres,
        }),
      ),
    );
  });

  return app;
}

function isCardLayout(value: unknown): value is CardLayout {
  return value === 'cards' || value === 'list';
}
