import { Hono } from 'hono';
import { ErrorCodes, ok, type DetailsPageSettings } from '@panel/shared';
import { AppError } from '../lib/errors.js';
import { loadDetailsSettings, saveDetailsSettings } from '../lib/detailsSettingsFile.js';

export function detailsSettingsRoutes(): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    return c.json(ok(loadDetailsSettings()));
  });

  app.put('/', async (c) => {
    const body = (await c.req.json()) as unknown;
    if (
      !body ||
      typeof body !== 'object' ||
      typeof (body as { showFillerLabels?: unknown }).showFillerLabels !== 'boolean'
    ) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Request body must be { showFillerLabels: boolean }.',
      );
    }
    const typed = body as DetailsPageSettings;
    return c.json(ok(saveDetailsSettings({ showFillerLabels: typed.showFillerLabels })));
  });

  return app;
}
