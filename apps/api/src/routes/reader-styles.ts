import { Hono } from 'hono';
import { ErrorCodes, ok } from '@panel/shared';
import { AppError } from '../lib/errors.js';
import { loadReaderStyles, saveReaderStyles } from '../lib/readerStylesFile.js';

export function readerStylesRoutes(): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    return c.json(ok(loadReaderStyles()));
  });

  app.put('/', async (c) => {
    const body = (await c.req.json()) as unknown;
    if (!Array.isArray(body)) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Request body must be an array of reader style presets.',
      );
    }
    return c.json(ok(saveReaderStyles(body)));
  });

  return app;
}
