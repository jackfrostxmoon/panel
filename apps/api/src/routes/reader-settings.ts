import { Hono } from 'hono';
import { ok } from '@panel/shared';
import { loadReaderSettings, saveReaderSettings } from '../lib/readerSettingsFile.js';
import type { ReaderSettings } from '@panel/shared';

export function readerSettingsRoutes(): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    return c.json(ok(loadReaderSettings()));
  });

  app.put('/', async (c) => {
    const body = (await c.req.json()) as ReaderSettings;
    saveReaderSettings(body);
    return c.json(ok(loadReaderSettings()));
  });

  return app;
}
