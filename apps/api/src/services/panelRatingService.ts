import {
  ErrorCodes,
  parseGlobalId,
  type PanelRating,
  type SetPanelRatingInput,
} from '@panel/shared';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { PanelRatingRepository } from '../repositories/bookmarkRepository.js';
import type { PanelCacheRepository } from '../repositories/panelCacheRepository.js';
import type { PanelRatingRow } from '../db/schema.js';

/**
 * User star-rating use-cases (T3-3). Ratings are 1–5 and stored per panel;
 * sending a rating again overwrites it. The rating's `updatedAt` doubles as
 * the "added vs already existed" signal for import flows.
 */
export class PanelRatingService {
  constructor(
    private readonly ratings: PanelRatingRepository,
    private readonly panelCache: PanelCacheRepository,
  ) {}

  async getByPanelId(globalPanelId: string): Promise<PanelRating | null> {
    const panelRow = await this.panelCache.findPanelByGlobalId(globalPanelId);
    if (!panelRow) return null;
    const row = await this.ratings.getByPanelRowId(panelRow.id);
    return row ? toApiRating(row, panelRow.globalId) : null;
  }

  async set(input: SetPanelRatingInput): Promise<PanelRating> {
    const parsed = parseGlobalId(input.panelId);
    if (!parsed) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid panel id.', {
        panelId: input.panelId,
      });
    }
    if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Rating must be 1–5.', {
        rating: input.rating,
      });
    }
    const panelRow = await this.panelCache.findPanelByGlobalId(input.panelId);
    if (!panelRow) {
      throw new AppError(ErrorCodes.PANEL_NOT_FOUND, 'Panel not found.', {
        panelId: input.panelId,
      });
    }
    const row = await this.ratings.upsert(panelRow.id, input.rating);
    logger.info('Rating saved', { panelId: input.panelId, rating: input.rating });
    return toApiRating(row, panelRow.globalId);
  }

  async clear(globalPanelId: string): Promise<void> {
    const panelRow = await this.panelCache.findPanelByGlobalId(globalPanelId);
    if (!panelRow) {
      throw new AppError(ErrorCodes.PANEL_NOT_FOUND, 'Panel not found.', {
        panelId: globalPanelId,
      });
    }
    await this.ratings.remove(panelRow.id);
  }
}

function toApiRating(row: PanelRatingRow, globalPanelId: string): PanelRating {
  return {
    panelId: globalPanelId,
    rating: row.rating,
    updatedAt: row.updatedAt.toISOString(),
  };
}