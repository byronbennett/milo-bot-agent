import { jest } from '@jest/globals';
import { personaFileName, resolvePersona } from '../../app/personas/resolver.js';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Persona Resolver', () => {
  let personasDir: string;

  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'milo-personas-'));
    personasDir = join(tmp, 'PERSONAS');
    mkdirSync(personasDir, { recursive: true });
  });

  describe('personaFileName', () => {
    it('constructs correct filename from id and version', () => {
      expect(personaFileName('abc123', 'v1')).toBe('abc123--v1.md');
    });

    it('handles longer ids', () => {
      expect(personaFileName('persona-long-id', 'version-42')).toBe('persona-long-id--version-42.md');
    });
  });

  describe('resolvePersona', () => {
    it('returns cached file when it exists on disk', async () => {
      const personaId = 'test-persona';
      const versionId = 'v1';
      const prompt = 'You are a test persona.';
      writeFileSync(join(personasDir, `${personaId}--${versionId}.md`), prompt);

      const result = await resolvePersona({
        personasDir,
        personaId,
        personaVersionId: versionId,
        apiUrl: 'http://localhost:3000/api',
        apiKey: 'test-key',
      });

      expect(result).toBe(prompt);
    });

    it('fetches from API when file missing and saves to disk', async () => {
      const personaId = 'remote-persona';
      const versionId = 'v2';
      const prompt = 'You are a remote persona.';

      // Mock fetch
      const originalFetch = globalThis.fetch;
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          personaId,
          personaVersionId: versionId,
          systemPrompt: prompt,
        }),
      }) as any;

      try {
        const result = await resolvePersona({
          personasDir,
          personaId,
          personaVersionId: versionId,
          apiUrl: 'http://localhost:3000/api',
          apiKey: 'test-key',
        });

        expect(result).toBe(prompt);

        // Verify file was cached
        const cachedPath = join(personasDir, `${personaId}--${versionId}.md`);
        expect(existsSync(cachedPath)).toBe(true);
        expect(readFileSync(cachedPath, 'utf-8')).toBe(prompt);

        // Verify fetch was called correctly
        expect(globalThis.fetch).toHaveBeenCalledWith(
          `http://localhost:3000/api/agent/personas/${personaId}`,
          expect.objectContaining({
            headers: expect.objectContaining({
              'x-api-key': 'test-key',
            }),
          }),
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('throws on API error', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ error: 'Persona not found' }),
      }) as any;

      try {
        await expect(
          resolvePersona({
            personasDir,
            personaId: 'nonexistent',
            personaVersionId: 'v1',
            apiUrl: 'http://localhost:3000/api',
            apiKey: 'test-key',
          }),
        ).rejects.toThrow('Failed to fetch persona nonexistent (404)');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('creates PERSONAS directory if missing', async () => {
      const freshDir = join(mkdtempSync(join(tmpdir(), 'milo-fresh-')), 'PERSONAS');
      // Don't create the directory — resolvePersona should create it

      const personaId = 'new-persona';
      const versionId = 'v1';
      const prompt = 'Fresh persona.';

      const originalFetch = globalThis.fetch;
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          personaId,
          personaVersionId: versionId,
          systemPrompt: prompt,
        }),
      }) as any;

      try {
        const result = await resolvePersona({
          personasDir: freshDir,
          personaId,
          personaVersionId: versionId,
          apiUrl: 'http://localhost:3000/api',
          apiKey: 'test-key',
        });

        expect(result).toBe(prompt);
        expect(existsSync(join(freshDir, `${personaId}--${versionId}.md`))).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
