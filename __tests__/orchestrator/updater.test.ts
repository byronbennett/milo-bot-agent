import { detectInstallMethod, getPackageRoot } from '../../app/orchestrator/updater.js';
import { mkdtempSync, mkdirSync } from 'fs';
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
});
