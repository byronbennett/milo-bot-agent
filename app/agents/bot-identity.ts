/**
 * Bot Identity Loader
 *
 * Loads and parses bot-identity .md files from the workspace agents/ directory.
 * Each file defines a persona with optional model/tool configuration via YAML frontmatter.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';

export interface BotIdentity {
  name: string;
  role?: string;
  model?: { provider: string; id: string };
  toolSet?: string | string[];
  systemPromptBody: string;
  filePath: string;
}

interface Frontmatter {
  name?: string;
  role?: string;
  model?: { provider: string; id: string };
  toolSet?: string | string[];
  [key: string]: unknown;
}

/**
 * Parse YAML-like frontmatter from a markdown file.
 * Supports simple key: value and one level of nesting.
 */
export function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fmMatch) {
    return { frontmatter: {} as Frontmatter, body: content.trim() };
  }

  const yamlBlock = fmMatch[1];
  const body = fmMatch[2];
  const frontmatter: Record<string, unknown> = {};

  let currentKey = '';
  let currentObj: Record<string, unknown> | null = null;

  for (const line of yamlBlock.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;

    // Nested key (indented with spaces)
    if (/^\s{2,}\w/.test(line) && currentKey) {
      const nestedMatch = trimmed.match(/^\s+(\w+):\s*(.+)$/);
      if (nestedMatch) {
        if (!currentObj) currentObj = {};
        currentObj[nestedMatch[1]] = nestedMatch[2].trim();
      }
      continue;
    }

    // Flush previous nested object
    if (currentKey && currentObj) {
      frontmatter[currentKey] = currentObj;
      currentObj = null;
    }

    const kvMatch = trimmed.match(/^(\w+):\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      const value = kvMatch[2].trim();
      if (value === '') {
        currentObj = {};
      } else {
        frontmatter[currentKey] = value;
        currentKey = '';
      }
    }
  }

  if (currentKey && currentObj) {
    frontmatter[currentKey] = currentObj;
  }

  return { frontmatter: frontmatter as Frontmatter, body: body.trim() };
}

/**
 * Load a bot-identity by name (without .md extension) or filename.
 * Returns null if not found.
 */
export function loadBotIdentity(agentsDir: string, nameOrFile: string): BotIdentity | null {
  const fileName = nameOrFile.endsWith('.md') ? nameOrFile : `${nameOrFile}.md`;
  const filePath = join(agentsDir, fileName);

  if (!existsSync(filePath)) return null;

  const raw = readFileSync(filePath, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(raw);

  return {
    name: (frontmatter.name as string) ?? basename(fileName, '.md'),
    role: frontmatter.role as string | undefined,
    model: frontmatter.model as { provider: string; id: string } | undefined,
    toolSet: frontmatter.toolSet as string | string[] | undefined,
    systemPromptBody: body,
    filePath,
  };
}

/**
 * List all bot-identities in the agents directory.
 */
export function listBotIdentities(agentsDir: string): BotIdentity[] {
  if (!existsSync(agentsDir)) return [];

  const files = readdirSync(agentsDir).filter((f) => f.endsWith('.md'));
  return files
    .map((f) => loadBotIdentity(agentsDir, f))
    .filter((id): id is BotIdentity => id !== null);
}
