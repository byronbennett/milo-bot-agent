import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { Logger } from '../utils/logger.js';

export interface SkillInstallResult {
  success: boolean;
  error?: string;
}

interface SkillInstallerOptions {
  skillsDir: string;
  apiUrl: string;
  apiKey: string;
  logger: Logger;
}

export class SkillInstaller {
  private skillsDir: string;
  private apiUrl: string;
  private apiKey: string;
  private logger: Logger;

  constructor(options: SkillInstallerOptions) {
    this.skillsDir = options.skillsDir;
    this.apiUrl = options.apiUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.logger = options.logger;

    if (!existsSync(this.skillsDir)) {
      mkdirSync(this.skillsDir, { recursive: true });
    }
  }

  async installSkill(
    slug: string,
    version: string,
    type: 'md' | 'zip',
    filename: string,
  ): Promise<SkillInstallResult> {
    try {
      this.logger.info(`Installing skill: ${slug} v${version}`);
      const buffer = await this.downloadSkill(slug);

      if (type === 'md') {
        const dest = join(this.skillsDir, `${slug}.md`);
        writeFileSync(dest, buffer);
        this.logger.info(`Skill saved to ${dest}`);
      } else {
        await this.extractZip(buffer, slug);
      }

      await this.reportInstalled(slug, version);
      this.logger.info(`Skill ${slug} v${version} installed successfully`);
      return { success: true };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`Failed to install skill ${slug}: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }

  async updateSkill(
    slug: string,
    version: string,
    type: 'md' | 'zip',
    filename: string,
  ): Promise<SkillInstallResult> {
    this.removeLocalFiles(slug);
    return this.installSkill(slug, version, type, filename);
  }

  async deleteSkill(slug: string): Promise<SkillInstallResult> {
    try {
      this.logger.info(`Deleting skill: ${slug}`);
      this.removeLocalFiles(slug);
      await this.reportUninstalled(slug);
      this.logger.info(`Skill ${slug} deleted successfully`);
      return { success: true };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`Failed to delete skill ${slug}: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }

  private async downloadSkill(slug: string): Promise<Buffer> {
    const url = `${this.apiUrl}/agent/skills/${slug}/download`;
    const response = await fetch(url, {
      headers: { 'x-api-key': this.apiKey },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: 'Unknown error' })) as { error?: string };
      throw new Error(`Download failed (${response.status}): ${body.error || response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  private async extractZip(buffer: Buffer, slug: string): Promise<void> {
    const { default: AdmZip } = await import('adm-zip');
    const zip = new AdmZip(buffer);
    const destDir = join(this.skillsDir, slug);

    // Safety checks
    const entries = zip.getEntries();
    if (entries.length > 100) {
      throw new Error('Zip contains too many files (max 100)');
    }
    const totalSize = entries.reduce((sum, e) => sum + e.header.size, 0);
    if (totalSize > 10 * 1024 * 1024) {
      throw new Error('Zip contents too large (max 10MB)');
    }
    for (const entry of entries) {
      if (entry.entryName.includes('..')) {
        throw new Error('Zip contains path traversal');
      }
    }

    if (existsSync(destDir)) {
      rmSync(destDir, { recursive: true });
    }
    mkdirSync(destDir, { recursive: true });
    zip.extractAllTo(destDir, true);
    this.logger.info(`Zip extracted to ${destDir}`);
  }

  private removeLocalFiles(slug: string): void {
    const mdPath = join(this.skillsDir, `${slug}.md`);
    const dirPath = join(this.skillsDir, slug);

    if (existsSync(mdPath)) {
      rmSync(mdPath);
      this.logger.verbose(`Removed ${mdPath}`);
    }
    if (existsSync(dirPath)) {
      rmSync(dirPath, { recursive: true });
      this.logger.verbose(`Removed ${dirPath}`);
    }
  }

  private async reportInstalled(slug: string, version: string): Promise<void> {
    const url = `${this.apiUrl}/agent/skills/${slug}/installed`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey },
      body: JSON.stringify({ version }),
    });
    if (!response.ok) {
      this.logger.error(`Failed to report skill install (${response.status}), retrying...`);
      const retry = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey },
        body: JSON.stringify({ version }),
      });
      if (!retry.ok) {
        this.logger.error(`Retry failed (${retry.status}). Skill installed locally but DB may be stale.`);
      }
    }
  }

  private async reportUninstalled(slug: string): Promise<void> {
    const url = `${this.apiUrl}/agent/skills/${slug}/installed`;
    const response = await fetch(url, {
      method: 'DELETE',
      headers: { 'x-api-key': this.apiKey },
    });
    if (!response.ok) {
      this.logger.error(`Failed to report skill uninstall (${response.status})`);
    }
  }
}
