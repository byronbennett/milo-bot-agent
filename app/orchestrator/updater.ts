/**
 * Agent self-update module.
 *
 * Detects install method (git clone vs npm global) and runs
 * the appropriate update commands.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type InstallMethod = 'git' | 'npm';

/**
 * Resolve the package root directory (where package.json lives).
 * Works whether running from source (app/) or built (dist/).
 */
export function getPackageRoot(): string {
  // __dirname is app/orchestrator or dist/orchestrator
  // Package root is two levels up
  return join(__dirname, '..', '..');
}

/**
 * Detect whether the agent was installed via git clone or npm global.
 */
export function detectInstallMethod(packageRoot: string): InstallMethod {
  return existsSync(join(packageRoot, '.git')) ? 'git' : 'npm';
}

export interface UpdateResult {
  success: boolean;
  method: InstallMethod;
  output: string;
  error?: string;
}

/**
 * Run the update commands for the detected install method.
 * Calls onProgress with status messages during execution.
 */
export function runUpdate(
  packageRoot: string,
  method: InstallMethod,
  onProgress: (message: string) => void,
): UpdateResult {
  const output: string[] = [];

  try {
    if (method === 'git') {
      onProgress('Pulling latest changes from git...');
      const pullOutput = execSync('git pull', {
        cwd: packageRoot,
        encoding: 'utf-8',
        timeout: 60_000,
      });
      output.push(pullOutput.trim());

      // Check if already up to date
      if (pullOutput.includes('Already up to date')) {
        return { success: true, method, output: 'Already up to date.' };
      }

      onProgress('Installing dependencies...');
      const installOutput = execSync('pnpm install --frozen-lockfile', {
        cwd: packageRoot,
        encoding: 'utf-8',
        timeout: 120_000,
      });
      output.push(installOutput.trim());

      onProgress('Building...');
      const buildOutput = execSync('pnpm build', {
        cwd: packageRoot,
        encoding: 'utf-8',
        timeout: 120_000,
      });
      output.push(buildOutput.trim());
    } else {
      onProgress('Updating via npm...');
      const npmOutput = execSync('npm update -g milo-bot-agent', {
        encoding: 'utf-8',
        timeout: 120_000,
      });
      output.push(npmOutput.trim());
    }

    return { success: true, method, output: output.join('\n') };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, method, output: output.join('\n'), error: message };
  }
}
