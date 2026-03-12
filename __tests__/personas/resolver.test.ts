import { jest } from '@jest/globals';
import { personaFileName, resolvePersona } from '../../app/personas/resolver.js';
import type { ResolvedPersona } from '../../app/personas/resolver.js';
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
    it('constructs correct JSON filename from id and version', () => {
      expect(personaFileName('abc123', 'v1')).toBe('abc123--v1.json');
    });

    it('handles longer ids', () => {
      expect(personaFileName('persona-long-id', 'version-42')).toBe('persona-long-id--version-42.json');
    });
  });

  describe('resolvePersona', () => {
    it('returns cached file when it exists on disk', async () => {
      const personaId = 'test-persona';
      const versionId = 'v1';
      const cached: ResolvedPersona = {
        systemPrompt: 'You are a test persona.',
        type: 'chat',
        project: null,
      };
      writeFileSync(join(personasDir, `${personaId}--${versionId}.json`), JSON.stringify(cached));

      const result = await resolvePersona({
        personasDir,
        personaId,
        personaVersionId: versionId,
        apiUrl: 'http://localhost:3000/api',
        apiKey: 'test-key',
      });

      expect(result).toEqual(cached);
    });

    it('returns cached project persona with project data', async () => {
      const personaId = 'project-persona';
      const versionId = 'v3';
      const cached: ResolvedPersona = {
        systemPrompt: 'You are a project persona.',
        type: 'project',
        project: {
          name: 'My App',
          description: 'A cool app',
          projectFolder: 'my-app',
          repoUrl: 'https://github.com/user/my-app',
        },
      };
      writeFileSync(join(personasDir, `${personaId}--${versionId}.json`), JSON.stringify(cached));

      const result = await resolvePersona({
        personasDir,
        personaId,
        personaVersionId: versionId,
        apiUrl: 'http://localhost:3000/api',
        apiKey: 'test-key',
      });

      expect(result).toEqual(cached);
      expect(result.type).toBe('project');
      expect(result.project?.name).toBe('My App');
      expect(result.project?.projectFolder).toBe('my-app');
    });

    it('fetches from API when file missing and saves to disk as JSON', async () => {
      const personaId = 'remote-persona';
      const versionId = 'v2';
      const prompt = 'You are a remote persona.';

      const originalFetch = globalThis.fetch;
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          persona: {
            id: personaId,
            versionId,
            systemPrompt: prompt,
            type: 'chat',
            project: null,
          },
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

        expect(result.systemPrompt).toBe(prompt);
        expect(result.type).toBe('chat');
        expect(result.project).toBeNull();

        // Verify JSON file was cached
        const cachedPath = join(personasDir, `${personaId}--${versionId}.json`);
        expect(existsSync(cachedPath)).toBe(true);
        const cachedData = JSON.parse(readFileSync(cachedPath, 'utf-8'));
        expect(cachedData.systemPrompt).toBe(prompt);
        expect(cachedData.type).toBe('chat');

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

    it('fetches project persona from API and includes project data', async () => {
      const personaId = 'project-persona';
      const versionId = 'v1';

      const originalFetch = globalThis.fetch;
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          persona: {
            id: personaId,
            versionId,
            systemPrompt: 'Project bot',
            type: 'project',
            project: {
              name: 'Frontend',
              description: 'React dashboard',
              projectFolder: 'frontend',
              repoUrl: null,
            },
          },
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

        expect(result.systemPrompt).toBe('Project bot');
        expect(result.type).toBe('project');
        expect(result.project).toEqual({
          name: 'Frontend',
          description: 'React dashboard',
          projectFolder: 'frontend',
          repoUrl: null,
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('defaults type to chat when API omits it', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          persona: { id: 'old', versionId: 1, systemPrompt: 'Hello' },
        }),
      }) as any;

      try {
        const result = await resolvePersona({
          personasDir,
          personaId: 'old',
          personaVersionId: '1',
          apiUrl: 'http://localhost:3000/api',
          apiKey: 'test-key',
        });

        expect(result.type).toBe('chat');
        expect(result.project).toBeNull();
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

      const personaId = 'new-persona';
      const versionId = 'v1';

      const originalFetch = globalThis.fetch;
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          persona: { id: personaId, versionId, systemPrompt: 'Fresh persona.', type: 'chat', project: null },
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

        expect(result.systemPrompt).toBe('Fresh persona.');
        expect(existsSync(join(freshDir, `${personaId}--${versionId}.json`))).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
