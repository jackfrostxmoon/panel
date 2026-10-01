import { Hono } from 'hono';
import { ErrorCodes, ok } from '@panel/shared';
import { AppError } from '../lib/errors.js';
import { loadSourceOrder, sanitizeSourceOrder, saveSourceOrder } from '../lib/sourceOrderFile.js';

export function sourceOrderRoutes(): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    return c.json(ok(loadSourceOrder()));
  });

  app.put('/', async (c) => {
    const body = (await c.req.json()) as unknown;
    if (!body || typeof body !== 'object' || !Array.isArray((body as { order?: unknown }).order)) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Request body must be { order: string[] } (source codes in user order, [] = canonical).',
      );
    }
    const typed = body as { order: unknown };
    // sanitizeSourceOrder drops non-strings/empties/dupes; a body whose
    // array holds nothing usable is rejected so typos can't wipe the order.
    const order = sanitizeSourceOrder(typed.order);
    if ((typed.order as unknown[]).length > 0 && order.length === 0) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Request body must be { order: string[] } (source codes in user order, [] = canonical).',
      );
    }
    return c.json(ok(saveSourceOrder({ order })));
  });

  return app;
}
