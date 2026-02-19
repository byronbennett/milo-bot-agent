import { jest } from '@jest/globals';
import { detectLocalModels } from '../../app/models/local-models.js';
import type { AgentConfig } from '../../app/config/schema.js';

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    localModels: {
      ollama: { enabled: true, port: 11434 },
      lmStudio: { enabled: true, port: 1234 },
      timeoutMs: 2000,
      ...overrides,
    },
  } as AgentConfig;
}

describe('Local Model Detection', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('detects Ollama models', async () => {
    const config = makeConfig({ lmStudio: { enabled: false, port: 1234 } });

    globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('11434')) {
        return {
          ok: true,
          json: async () => ({
            models: [
              { name: 'llama3:latest' },
              { name: 'codellama:7b' },
            ],
          }),
        } as Response;
      }
      throw new Error('Unexpected fetch');
    });

    const result = await detectLocalModels(config);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ name: 'llama3:latest', provider: 'ollama' });
    expect(result[1]).toEqual({ name: 'codellama:7b', provider: 'ollama' });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('detects LM Studio models', async () => {
    const config = makeConfig({ ollama: { enabled: false, port: 11434 } });

    globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('1234')) {
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: 'mistral-7b-instruct' },
              { id: 'phi-2' },
            ],
          }),
        } as Response;
      }
      throw new Error('Unexpected fetch');
    });

    const result = await detectLocalModels(config);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ name: 'mistral-7b-instruct', provider: 'lm-studio' });
    expect(result[1]).toEqual({ name: 'phi-2', provider: 'lm-studio' });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns empty array when neither is available (fetch rejects)', async () => {
    const config = makeConfig();

    globalThis.fetch = jest.fn<typeof fetch>().mockRejectedValue(
      new Error('Connection refused'),
    );

    const result = await detectLocalModels(config);

    expect(result).toEqual([]);
  });

  it('respects disabled config (fetch not called when disabled)', async () => {
    const config = makeConfig({
      ollama: { enabled: false, port: 11434 },
      lmStudio: { enabled: false, port: 1234 },
    });

    globalThis.fetch = jest.fn<typeof fetch>();

    const result = await detectLocalModels(config);

    expect(result).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('uses custom ports from config', async () => {
    const config = makeConfig({
      ollama: { enabled: true, port: 9999 },
      lmStudio: { enabled: true, port: 8888 },
    });

    globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('9999')) {
        return {
          ok: true,
          json: async () => ({ models: [{ name: 'custom-ollama-model' }] }),
        } as Response;
      }
      if (url.includes('8888')) {
        return {
          ok: true,
          json: async () => ({ data: [{ id: 'custom-lms-model' }] }),
        } as Response;
      }
      throw new Error('Unexpected fetch');
    });

    const result = await detectLocalModels(config);

    expect(result).toHaveLength(2);
    expect(result.find(m => m.provider === 'ollama')?.name).toBe('custom-ollama-model');
    expect(result.find(m => m.provider === 'lm-studio')?.name).toBe('custom-lms-model');

    // Verify correct URLs were called
    const calls = (globalThis.fetch as jest.Mock).mock.calls;
    const urls = calls.map(c => String(c[0]));
    expect(urls.some(u => u.includes('localhost:9999/api/tags'))).toBe(true);
    expect(urls.some(u => u.includes('localhost:8888/v1/models'))).toBe(true);
  });
});
