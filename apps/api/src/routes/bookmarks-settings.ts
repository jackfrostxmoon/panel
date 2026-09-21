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
    if (!body || typeof body !== 'object' || !isCardLayout((body as { cardLayout?: unknown }).cardLayout)) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Request body must be { cardLayout: "cards" | "list" }.',
      );
    }
    const typed = body as { cardLayout: CardLayout };
    return c.json(ok(saveBookmarksSettings({ cardLayout: typed.cardLayout })));
  });

  return app;
}

function isCardLayout(value: unknown): value is CardLayout {
  return value === 'cards' || value === 'list';
}
