import { loadBotIdentity, listBotIdentities, parseFrontmatter } from '../../app/agents/bot-identity.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Bot Identity', () => {
  let agentsDir: string;

  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'milo-test-'));
    agentsDir = join(tmp, 'agents');
    mkdirSync(agentsDir);
  });

  describe('parseFrontmatter', () => {
    it('parses YAML frontmatter and body', () => {
      const content = `---\nname: Matt\nrole: CTO\nmodel:\n  provider: anthropic\n  id: claude-sonnet-4-20250514\ntoolSet: full\n---\n\n# Matt\n\nYou are Matt, a CTO.`;
      const result = parseFrontmatter(content);
      expect(result.frontmatter.name).toBe('Matt');
      expect(result.frontmatter.role).toBe('CTO');
      expect((result.frontmatter.model as any).provider).toBe('anthropic');
      expect(result.frontmatter.toolSet).toBe('full');
      expect(result.body).toContain('You are Matt');
    });

    it('handles missing frontmatter', () => {
      const content = '# Just a body\n\nNo frontmatter here.';
      const result = parseFrontmatter(content);
      expect(result.frontmatter).toEqual({});
      expect(result.body).toContain('Just a body');
    });
  });

  describe('loadBotIdentity', () => {
    it('loads a bot-identity by name', () => {
      writeFileSync(join(agentsDir, 'matt.md'), '---\nname: Matt\nrole: CTO\n---\n\nYou are Matt.');
      const identity = loadBotIdentity(agentsDir, 'matt');
      expect(identity).not.toBeNull();
      expect(identity!.name).toBe('Matt');
      expect(identity!.role).toBe('CTO');
      expect(identity!.systemPromptBody).toContain('You are Matt');
    });

    it('uses filename as name when frontmatter name is missing', () => {
      writeFileSync(join(agentsDir, 'dev.md'), 'You are a developer.');
      const identity = loadBotIdentity(agentsDir, 'dev');
      expect(identity!.name).toBe('dev');
    });

    it('returns null for non-existent identity', () => {
      expect(loadBotIdentity(agentsDir, 'nobody')).toBeNull();
    });
  });

  describe('listBotIdentities', () => {
    it('lists all .md files in agents dir', () => {
      writeFileSync(join(agentsDir, 'a.md'), 'Agent A');
      writeFileSync(join(agentsDir, 'b.md'), 'Agent B');
      const identities = listBotIdentities(agentsDir);
      expect(identities).toHaveLength(2);
      expect(identities.map((i) => i.name).sort()).toEqual(['a', 'b']);
    });

    it('returns empty array if dir does not exist', () => {
      expect(listBotIdentities('/nonexistent/path')).toEqual([]);
    });
  });
});
