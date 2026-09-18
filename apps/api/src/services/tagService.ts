import {
  ErrorCodes,
  parseGlobalId,
  type Tag,
  type TagWithPanel,
} from '@panel/shared';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { TagRepository } from '../repositories/bookmarkRepository.js';
import type { PanelCacheRepository } from '../repositories/panelCacheRepository.js';
import type { TagRow } from '../db/schema.js';

const MAX_TAG_NAME = 32;

/**
 * Custom-tag use-cases (T3-4). Tags are free-form labels the user applies
 * to panel; they are created on demand and matched case-insensitively
 * (stored lowercase). Replacing a panel's set prunes tags left orphaned.
 */
export class TagService {
  constructor(
    private readonly tags: TagRepository,
    private readonly panelCache: PanelCacheRepository,
  ) {}

  async list(): Promise<Tag[]> {
    const rows = await this.tags.list();
    return rows.map(toApiTag);
  }

  async listWithPanel(): Promise<TagWithPanel[]> {
    const [rows, mapping] = await Promise.all([
      this.tags.list(),
      this.tags.listPanelRowIdsByTag(),
    ]);
    // Map row ids → global ids in one query round-trip per tag row id set.
    const panelRowIds = [...new Set(mapping.map((m) => m.panelId))];
    const globalById = new Map<string, string>();
    for (const rowId of panelRowIds) {
      const row = await this.panelCache.findPanelByRowId(rowId);
      if (row) globalById.set(rowId, row.globalId);
    }
    return rows.map((tag) => ({
      ...toApiTag(tag),
      panelIds: mapping
        .filter((m) => m.tagId === tag.id)
        .map((m) => globalById.get(m.panelId))
        .filter((id): id is string => !!id),
    }));
  }

  async listByPanelId(globalPanelId: string): Promise<Tag[]> {
    const panelRow = await this.panelCache.findPanelByGlobalId(globalPanelId);
    if (!panelRow) return [];
    const rows = await this.tags.listByPanelRowId(panelRow.id);
    return rows.map(toApiTag);
  }

  /** Replace a panel's tag set. Names are trimmed, lowercased, de-duped. */
  async setPanelTags(globalPanelId: string, names: string[]): Promise<Tag[]> {
    const parsed = parseGlobalId(globalPanelId);
    if (!parsed) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid panel id.', {
        panelId: globalPanelId,
      });
    }
    const panelRow = await this.panelCache.findPanelByGlobalId(globalPanelId);
    if (!panelRow) {
      throw new AppError(ErrorCodes.PANEL_NOT_FOUND, 'Panel not found.', {
        panelId: globalPanelId,
      });
    }
    const normalized = [
      ...new Set(
        names
          .map((n) => n.trim().toLowerCase())
          .filter((n) => n.length > 0 && n.length <= MAX_TAG_NAME),
      ),
    ];
    const tagRows = [];
    for (const name of normalized) {
      tagRows.push(await this.tags.ensure(name));
    }
    await this.tags.setPanelTags(panelRow.id, tagRows.map((t) => t.id));
    const pruned = await this.tags.pruneOrphans();
    if (pruned > 0) logger.info('Pruned orphaned tags', { count: pruned });
    return tagRows.map(toApiTag);
  }

  async create(name: string): Promise<Tag> {
    const trimmed = (name ?? '').trim().toLowerCase();
    if (!trimmed || trimmed.length > MAX_TAG_NAME) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, `Tag name must be 1–${MAX_TAG_NAME} chars.`, {
        name,
      });
    }
    return toApiTag(await this.tags.ensure(trimmed));
  }

  async remove(globalTagId: string): Promise<void> {
    // The id is a uuid; the client sends the tag row id.
    const deleted = await this.tags.delete(globalTagId);
    if (!deleted) {
      throw new AppError(ErrorCodes.NOT_FOUND, 'Tag not found.', { tagId: globalTagId });
    }
  }
}

function toApiTag(row: TagRow): Tag {
  return { id: row.id, name: row.name };
}