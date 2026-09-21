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
      !isCardLayout((body as { cardLayout?: unknown }).cardLayout)
    ) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Request body must be { infiniteScroll: boolean, cardLayout: "cards" | "list" }.',
      );
    }
    const typed = body as { infiniteScroll: boolean; cardLayout: CardLayout };
    return c.json(
      ok(saveLatestSettings({ infiniteScroll: typed.infiniteScroll, cardLayout: typed.cardLayout })),
    );
  });

  return app;
}

function isCardLayout(value: unknown): value is CardLayout {
  return value === 'cards' || value === 'list';
}
