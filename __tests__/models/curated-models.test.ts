import { jest } from '@jest/globals';
import {
  getCuratedAllowList,
  invalidateCuratedCache,
} from '../../app/models/curated-models.js';

type CuratedModel = { provider: string; modelId: string; displayName: string };

function createMockAdapter(models: CuratedModel[]) {
  return {
    getCuratedModels: jest.fn<() => Promise<CuratedModel[]>>().mockResolvedValue(models),
  } as any;
}

const sampleModels: CuratedModel[] = [
  { provider: 'anthropic', modelId: 'claude-opus-4-6', displayName: 'Claude Opus 4.6' },
  { provider: 'anthropic', modelId: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6' },
  { provider: 'openai', modelId: 'gpt-4.1', displayName: 'GPT-4.1' },
];

describe('Curated Models Cache', () => {
  beforeEach(() => {
    invalidateCuratedCache();
  });

  it('fetches and caches curated models (maps provider -> Set of modelIds)', async () => {
    const adapter = createMockAdapter(sampleModels);

    const result = await getCuratedAllowList(adapter);

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(2);
    expect(result.get('anthropic')).toBeInstanceOf(Set);
    expect(result.get('anthropic')?.has('claude-opus-4-6')).toBe(true);
    expect(result.get('anthropic')?.has('claude-sonnet-4-6')).toBe(true);
    expect(result.get('openai')?.has('gpt-4.1')).toBe(true);
    expect(adapter.getCuratedModels).toHaveBeenCalledTimes(1);
  });

  it('returns cached data on subsequent calls (adapter only called once)', async () => {
    const adapter = createMockAdapter(sampleModels);

    await getCuratedAllowList(adapter);
    const second = await getCuratedAllowList(adapter);

    expect(adapter.getCuratedModels).toHaveBeenCalledTimes(1);
    expect(second.get('anthropic')?.has('claude-opus-4-6')).toBe(true);
  });

  it('force-refreshes when requested', async () => {
    const adapter = createMockAdapter(sampleModels);

    await getCuratedAllowList(adapter);
    await getCuratedAllowList(adapter, true);

    expect(adapter.getCuratedModels).toHaveBeenCalledTimes(2);
  });

  it('returns empty map on fetch failure (no prior cache)', async () => {
    const adapter = {
      getCuratedModels: jest.fn<() => Promise<CuratedModel[]>>().mockRejectedValue(
        new Error('Network error'),
      ),
    } as any;

    const result = await getCuratedAllowList(adapter);

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it('returns stale cache on fetch failure when cache exists', async () => {
    const adapter = createMockAdapter(sampleModels);

    // First call populates cache
    await getCuratedAllowList(adapter);

    // Make next call fail
    adapter.getCuratedModels.mockRejectedValue(new Error('Network error'));

    // Force refresh triggers a fetch, which fails, but stale cache is returned
    const result = await getCuratedAllowList(adapter, true);

    expect(result.get('anthropic')?.has('claude-opus-4-6')).toBe(true);
    expect(result.get('openai')?.has('gpt-4.1')).toBe(true);
  });

  it('invalidates cache (adapter called again after invalidation)', async () => {
    const adapter = createMockAdapter(sampleModels);

    await getCuratedAllowList(adapter);
    invalidateCuratedCache();
    await getCuratedAllowList(adapter);

    expect(adapter.getCuratedModels).toHaveBeenCalledTimes(2);
  });
});
