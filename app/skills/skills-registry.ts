/**
 * Skills Registry
 *
 * Scans the SKILLS folder in the workspace and builds a system prompt addendum
 * listing available skills for the worker agent.
 *
 * Skills can be:
 * - A single .md file (e.g., SKILLS/my-skill.md)
 * - A folder containing a base .md file with the skill name and supporting files
 *   (e.g., SKILLS/complex-skill/complex-skill.md + scripts, images, docs, etc.)
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, basename } from 'path';

export interface SkillEntry {
  name: string;
  path: string;
  baseDir: string;
  description: string;
}

/**
 * Extract a short description from the first meaningful line(s) of a skill .md file.
 * Looks for: YAML front-matter `description:`, first paragraph after the title, or first non-empty line.
 */
function extractDescription(content: string): string {
  const lines = content.split('\n');

  // Check for YAML front-matter description
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === '---') break;
      const match = lines[i]?.match(/^description:\s*(.+)/i);
      if (match) return match[1].trim().slice(0, 200);
    }
  }

  // Find first non-title, non-empty line as description
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    if (trimmed === '---') continue;
    // Return first paragraph text, capped
    return trimmed.slice(0, 200);
  }

  return 'No description available';
}

/**
 * Scan the SKILLS directory and return a list of discovered skills.
 */
export function discoverSkills(skillsDir: string): SkillEntry[] {
  if (!existsSync(skillsDir)) return [];

  const entries = readdirSync(skillsDir);
  const skills: SkillEntry[] = [];

  for (const entry of entries) {
    const fullPath = join(skillsDir, entry);
    const stat = statSync(fullPath);

    if (stat.isFile() && entry.endsWith('.md')) {
      // Single .md file skill
      const name = basename(entry, '.md');
      const content = readFileSync(fullPath, 'utf-8');
      skills.push({
        name,
        path: fullPath,
        baseDir: skillsDir,
        description: extractDescription(content),
      });
    } else if (stat.isDirectory()) {
      // Folder-based skill — check for base .md file matching folder name, or SKILL.md
      const baseMd = join(fullPath, `${entry}.md`);
      const skillMd = join(fullPath, 'SKILL.md');
      const mdPath = existsSync(baseMd) ? baseMd : existsSync(skillMd) ? skillMd : null;
      if (mdPath) {
        const content = readFileSync(mdPath, 'utf-8');
        skills.push({
          name: entry,
          path: mdPath,
          baseDir: fullPath,
          description: extractDescription(content),
        });
      }
    }
  }

  return skills;
}

/**
 * Build a system prompt section describing available skills.
 * Returns an empty string if no skills are found.
 */
export function buildSkillsPromptSection(skillsDir: string): string {
  const skills = discoverSkills(skillsDir);
  if (skills.length === 0) return '';

  const skillsList = JSON.stringify(
    skills.map((s) => ({ name: s.name, path: s.path, baseDir: s.baseDir, description: s.description })),
    null,
    2,
  );

  return `## Available Skills

The following skills are available in the workspace skills directory (\`${skillsDir}\`).
Each skill has a \`.md\` definition file you can read for detailed instructions on what it does and how to use it.
When a skill's \`.md\` file contains \`{baseDir}\`, replace it with that skill's \`baseDir\` path shown below.

\`\`\`json
${skillsList}
\`\`\``;
}
