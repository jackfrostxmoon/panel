import { Hono } from 'hono';
import { ErrorCodes, ok, type CardLayout } from '@panel/shared';
import { AppError } from '../lib/errors.js';
import { loadSearchSettings, saveSearchSettings } from '../lib/searchSettingsFile.js';

export function searchSettingsRoutes(): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    return c.json(ok(loadSearchSettings()));
  });

  app.put('/', async (c) => {
    const body = (await c.req.json()) as unknown;
    if (
      !body ||
      typeof body !== 'object' ||
      typeof (body as { infiniteScroll?: unknown }).infiniteScroll !== 'boolean' ||
      !isCardLayout((body as { cardLayout?: unknown }).cardLayout) ||
      typeof (body as { filtersCollapsed?: unknown }).filtersCollapsed !== 'boolean'
    ) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Request body must be { infiniteScroll: boolean, cardLayout: "cards" | "list", filtersCollapsed: boolean }.',
      );
    }
    const typed = body as { infiniteScroll: boolean; cardLayout: CardLayout; filtersCollapsed: boolean };
    return c.json(
      ok(
        saveSearchSettings({
          infiniteScroll: typed.infiniteScroll,
          cardLayout: typed.cardLayout,
          filtersCollapsed: typed.filtersCollapsed,
        }),
      ),
    );
  });

  return app;
}

function isCardLayout(value: unknown): value is CardLayout {
  return value === 'cards' || value === 'list';
}
