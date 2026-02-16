/**
 * Persona Resolver
 *
 * Resolves persona system prompts by checking the local PERSONAS cache
 * directory first, then falling back to the web API.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface ResolvePersonaOptions {
  personasDir: string;
  personaId: string;
  personaVersionId: string;
  apiUrl: string;
  apiKey: string;
}

/**
 * Build the cache filename for a persona version.
 */
export function personaFileName(personaId: string, personaVersionId: string): string {
  return `${personaId}--${personaVersionId}.md`;
}

/**
 * Resolve a persona's system prompt text.
 *
 * 1. Check if the file exists in personasDir
 * 2. If yes, read and return it
 * 3. If no, fetch from API, save to disk, return
 */
export async function resolvePersona(opts: ResolvePersonaOptions): Promise<string> {
  const { personasDir, personaId, personaVersionId, apiUrl, apiKey } = opts;
  const fileName = personaFileName(personaId, personaVersionId);
  const filePath = join(personasDir, fileName);

  // Check cache
  if (existsSync(filePath)) {
    return readFileSync(filePath, 'utf-8');
  }

  // Fetch from API
  const url = `${apiUrl}/agent/personas/${personaId}`;
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ error: 'Unknown error' })) as { error?: string };
    throw new Error(`Failed to fetch persona ${personaId} (${response.status}): ${errorBody.error || response.statusText}`);
  }

  const data = await response.json() as {
    persona: { id: string; versionId: number; systemPrompt: string | null };
  };

  const systemPrompt = data.persona.systemPrompt ?? '';

  // Ensure directory exists and write cache file
  mkdirSync(personasDir, { recursive: true });
  writeFileSync(filePath, systemPrompt, 'utf-8');

  return systemPrompt;
}
