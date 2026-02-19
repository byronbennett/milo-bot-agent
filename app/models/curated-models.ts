import type { WebAppAdapter } from '../messaging/webapp-adapter.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('curated-models');

interface CachedData {
  /** provider -> Set of allowed model IDs */
  allowList: Map<string, Set<string>>;
  /** Full model records for display name lookup */
  models: Array<{ provider: string; modelId: string; displayName: string }>;
  expiresAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

let cache: CachedData | null = null;

/**
 * Fetch the curated allow-list from the server, with in-memory caching.
 * Returns an empty map on failure (caller should fall back to unfiltered).
 */
export async function getCuratedAllowList(
  adapter: WebAppAdapter,
  forceRefresh = false,
): Promise<Map<string, Set<string>>> {
  const now = Date.now();
  if (!forceRefresh && cache && now < cache.expiresAt) {
    return cache.allowList;
  }

  try {
    const models = await adapter.getCuratedModels();
    const allowList = new Map<string, Set<string>>();

    for (const m of models) {
      if (!allowList.has(m.provider)) {
        allowList.set(m.provider, new Set());
      }
      allowList.get(m.provider)!.add(m.modelId);
    }

    cache = { allowList, models, expiresAt: now + CACHE_TTL_MS };
    logger.info(`Loaded ${models.length} curated models from server`);
    return allowList;
  } catch (err) {
    logger.warn('Failed to fetch curated models, using cache or unfiltered:', err);
    // Return stale cache if available, otherwise empty (triggers unfiltered fallback)
    return cache?.allowList ?? new Map();
  }
}

/**
 * Invalidate the cache so the next call fetches fresh data.
 */
export function invalidateCuratedCache(): void {
  cache = null;
}
