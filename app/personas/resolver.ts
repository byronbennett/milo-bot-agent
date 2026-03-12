/**
 * Persona Resolver
 *
 * Resolves persona data by checking the local PERSONAS cache
 * directory first, then falling back to the web API.
 *
 * Returns a ResolvedPersona object containing systemPrompt, type,
 * and optional project info. Cached as JSON files.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface PersonaProject {
  name: string;
  description?: string | null;
  projectFolder: string;
  repoUrl?: string | null;
}

export interface ResolvedPersona {
  systemPrompt: string;
  type: 'chat' | 'project';
  project?: PersonaProject | null;
}

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
  return `${personaId}--${personaVersionId}.json`;
}

/**
 * Resolve a persona's full data including project info.
 *
 * 1. Check if the JSON cache file exists in personasDir
 * 2. If yes, read, parse, and return it
 * 3. If no, fetch from API, save to disk, return
 */
export async function resolvePersona(opts: ResolvePersonaOptions): Promise<ResolvedPersona> {
  const { personasDir, personaId, personaVersionId, apiUrl, apiKey } = opts;
  const fileName = personaFileName(personaId, personaVersionId);
  const filePath = join(personasDir, fileName);

  // Check cache
  if (existsSync(filePath)) {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as ResolvedPersona;
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
    persona: {
      id: string;
      versionId: number;
      systemPrompt: string | null;
      type?: 'chat' | 'project';
      project?: PersonaProject | null;
    };
  };

  const resolved: ResolvedPersona = {
    systemPrompt: data.persona.systemPrompt ?? '',
    type: data.persona.type ?? 'chat',
    project: data.persona.project ?? null,
  };

  // Ensure directory exists and write cache file
  mkdirSync(personasDir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(resolved), 'utf-8');

  return resolved;
}
