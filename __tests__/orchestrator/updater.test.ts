import { detectInstallMethod, getPackageRoot, getCurrentVersion, getLatestVersion } from '../../app/orchestrator/updater.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('updater', () => {
  describe('getPackageRoot', () => {
    it('returns a directory path', () => {
      const root = getPackageRoot();
      expect(typeof root).toBe('string');
      expect(root.length).toBeGreaterThan(0);
    });
  });

  describe('detectInstallMethod', () => {
    it('returns git when .git directory exists', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'milo-updater-'));
      mkdirSync(join(tmp, '.git'));
      expect(detectInstallMethod(tmp)).toBe('git');
    });

    it('returns npm when .git directory does not exist', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'milo-updater-'));
      expect(detectInstallMethod(tmp)).toBe('npm');
    });
  });

  describe('getCurrentVersion', () => {
    it('returns git SHA for git installs', () => {
      // Use the actual repo (which is a git repo)
      const root = getPackageRoot();
      const version = getCurrentVersion(root, 'git');
      expect(version).toMatch(/^[a-f0-9]{7,}$/);
    });

    it('returns package.json version for npm installs', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'milo-updater-'));
      writeFileSync(join(tmp, 'package.json'), JSON.stringify({ version: '1.2.3' }));
      const version = getCurrentVersion(tmp, 'npm');
      expect(version).toBe('1.2.3');
    });
  });
});
