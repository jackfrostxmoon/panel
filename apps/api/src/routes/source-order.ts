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
        'Request body must be { order: string[], hidden?: string[] } (source codes in user order, [] = canonical).',
      );
    }
    const typed = body as { order: unknown; hidden?: unknown };
    // sanitizeSourceOrder drops non-strings/empties/dupes; a body whose
    // array holds nothing usable is rejected so typos can't wipe the order.
    const order = sanitizeSourceOrder(typed.order);
    if ((typed.order as unknown[]).length > 0 && order.length === 0) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Request body must be { order: string[], hidden?: string[] } (source codes in user order, [] = canonical).',
      );
    }
    // `hidden` is optional (order-only clients predate it); when present it
    // gets the same treatment — a non-empty array sanitizing to nothing is
    // rejected so typos can't silently unhide everything.
    const hiddenRaw = typed.hidden ?? [];
    if (!Array.isArray(hiddenRaw)) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Field "hidden" must be a string array of source codes ([] = everything visible).',
      );
    }
    const hidden = sanitizeSourceOrder(hiddenRaw);
    if (hiddenRaw.length > 0 && hidden.length === 0) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Field "hidden" must be a string array of source codes ([] = everything visible).',
      );
    }
    return c.json(ok(saveSourceOrder({ order, hidden })));
  });

  return app;
}
