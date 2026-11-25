import { Hono } from 'hono';
import { z } from 'zod';
import { ErrorCodes, ok } from '@panel/shared';
import { AppError } from '../lib/errors.js';
import { loadReaderSettings, saveReaderSettings } from '../lib/readerSettingsFile.js';
import type { ReaderSettings } from '@panel/shared';

/**
 * Field-by-field validation for `PUT /api/reader-settings`.
 *
 * Unlike the other settings routes this one used to persist the parsed
 * body verbatim — any JSON, any size, any unknown keys, straight to disk.
 * The schema bounds every value to its legitimate range and STRIPS unknown
 * keys, so:
 *   - a body can no longer fill the disk with junk (the server-wide body
 *     cap still applies, but the file written is always small);
 *   - unknown/typo'd fields can't ride along into every later response;
 *   - a malformed field falls back to its default (`.catch`) instead of
 *     failing the whole request — partial bodies from older clients keep
 *     working, same as `loadReaderSettings`'s merge-over-defaults semantics.
 */
const readerSettingsSchema = z
  .object({
    mode: z.enum(['vertical', 'paged', 'gallery']).catch('vertical'),
    direction: z.enum(['ltr', 'rtl']).catch('ltr'),
    background: z.enum(['dark', 'light', 'high-contrast']).catch('dark'),
    imageWidth: z.number().int().min(5).max(200).catch(60),
    imageWidthPx: z.number().int().min(50).max(8000).nullable().catch(null),
    imageHeightPx: z.number().int().min(50).max(8000).nullable().catch(null),
    pixelSizeEnabled: z.boolean().catch(false),
    showProgressBar: z.boolean().catch(true),
    imageGap: z.boolean().catch(false),
    clearToolbarSpace: z.boolean().catch(true),
    scrollSpeed: z.enum(['slow', 'normal', 'fast']).catch('normal'),
    smoothScrollKeys: z.boolean().catch(false),
    imageLoad: z.enum(['parallel', 'sequential']).catch('sequential'),
    preloadAhead: z.number().int().min(1).max(50).catch(3),
    imageBrightness: z.number().int().min(20).max(200).catch(100),
    doublePage: z.boolean().catch(false),
    spreadOddPolicy: z.enum(['duplicate', 'blank', 'single']).catch('blank'),
    autoScrollDelayMs: z.number().int().min(0).max(60_000).nullable().catch(3500),
    showAutoScrollButton: z.boolean().catch(false),
    wheelPagesPerNotch: z.number().int().min(0).max(10).catch(0),
    keyPagesPress: z.number().int().min(0).max(10).catch(0),
    fitToHeight: z.boolean().catch(false),
    fitToWidth: z.boolean().catch(false),
    autoLandscapeSingle: z.boolean().catch(true),
    dataSaver: z.boolean().catch(false),
    glidePreset: z.enum(['instant', 'quick', 'normal', 'smooth']).catch('quick'),
    showScrollbar: z.boolean().catch(false),
    defaultFolderId: z.string().max(64).nullable().catch(null),
    mkImageServer: z.enum(['default', 'sv2', 'sv3']).catch('default'),
    /**
     * Manual page merges for paged mode: chapter id -> ordered adjacent pairs
     * of 0-based page indices. Bounded so a client can't grow the settings
     * file without limit; ids are capped at the global-id length.
     */
    manualSpreads: z
      .record(
        z.string().max(200),
        z
          .array(
            z.tuple([
              z.number().int().min(0).max(10_000),
              z.number().int().min(0).max(10_000),
            ]),
          )
          .max(200),
      )
      .catch({}),
    /** Per-chapter 1-based first page of the automatic spread pairing. */
    spreadStarts: z
      .record(z.string().max(200), z.number().int().min(1).max(10_000))
      .catch({}),
  })
  // Unknown keys are dropped (zod strips them) — they never reach the disk.
  .strip();

export function readerSettingsRoutes(): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    return c.json(ok(loadReaderSettings()));
  });

  app.put('/', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Request body must be a reader-settings object.',
      );
    }
    const parsed = readerSettingsSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid reader settings.');
    }
    saveReaderSettings(parsed.data as ReaderSettings);
    return c.json(ok(loadReaderSettings()));
  });

  return app;
}
