import { Hono } from 'hono';
import { ErrorCodes, ok, type CardLayout } from '@panel/shared';
import { AppError } from '../lib/errors.js';
import { loadBookmarksSettings, saveBookmarksSettings } from '../lib/bookmarksSettingsFile.js';

export function bookmarksSettingsRoutes(): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    return c.json(ok(loadBookmarksSettings()));
  });

  app.put('/', async (c) => {
    const body = (await c.req.json()) as unknown;
    if (
      !body ||
      typeof body !== 'object' ||
      !isCardLayout((body as { cardLayout?: unknown }).cardLayout) ||
      typeof (body as { filtersCollapsed?: unknown }).filtersCollapsed !== 'boolean' ||
      typeof (body as { searchOpen?: unknown }).searchOpen !== 'boolean' ||
      typeof (body as { sortByLatestUpdate?: unknown }).sortByLatestUpdate !== 'boolean'
    ) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Request body must be { cardLayout: "cards" | "list", filtersCollapsed: boolean, searchOpen: boolean, sortByLatestUpdate: boolean }.',
      );
    }
    const typed = body as {
      cardLayout: CardLayout;
      filtersCollapsed: boolean;
      searchOpen: boolean;
      sortByLatestUpdate: boolean;
    };
    return c.json(
      ok(
        saveBookmarksSettings({
          cardLayout: typed.cardLayout,
          filtersCollapsed: typed.filtersCollapsed,
          searchOpen: typed.searchOpen,
          sortByLatestUpdate: typed.sortByLatestUpdate,
        }),
      ),
    );
  });

  return app;
}

function isCardLayout(value: unknown): value is CardLayout {
  return value === 'cards' || value === 'list';
}
