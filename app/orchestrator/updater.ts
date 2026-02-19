/**
 * Agent self-update module.
 *
 * Detects install method (git clone vs npm global) and runs
 * the appropriate update commands.
 */

import { spawn, execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'fs';
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

const GITHUB_REPO = 'byronbennett/milo-bot-agent';
const NPM_PACKAGE = 'milo-bot-agent';
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export { UPDATE_CHECK_INTERVAL_MS };

/**
 * Get the current version of the agent.
 * Git installs: short commit SHA. npm installs: package.json version.
 */
export function getCurrentVersion(packageRoot: string, method: InstallMethod): string {
  if (method === 'git') {
    try {
      return execSync('git rev-parse --short HEAD', {
        cwd: packageRoot,
        encoding: 'utf-8',
        timeout: 5_000,
      }).trim();
    } catch {
      return 'unknown';
    }
  }

  // npm: read version from package.json
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export interface DaemonOptions {
  agentPid: number;
  packageRoot: string;
  method: InstallMethod;
  startCommand: string[]; // [node, script, ...args]
  workspaceDir: string;
}

/**
 * Spawn a detached update daemon script.
 *
 * The daemon waits for the current agent process to exit, runs the
 * appropriate update commands (git pull + build, or npm update -g),
 * then restarts the agent using the original process.argv.
 * If the update/build fails it still restarts on the old code so the
 * agent doesn't stay dead.
 */
export function spawnUpdateDaemon(opts: DaemonOptions): void {
  const { agentPid, packageRoot, method, startCommand, workspaceDir } = opts;
  const scriptPath = join(workspaceDir, '.update-daemon.sh');
  const logPath = join(workspaceDir, 'update.log');
  const restartScriptPath = join(workspaceDir, '.restart-agent.command');

  // Shell-escape a string for use inside single quotes
  const esc = (s: string) => s.replace(/'/g, "'\\''");

  const quotedStart = startCommand.map((a) => `'${esc(a)}'`).join(' ');

  const updateSteps =
    method === 'git'
      ? `
git pull >> "$LOG" 2>&1
if [ $? -ne 0 ]; then
  echo "[$TS] ERROR: git pull failed" >> "$LOG"
fi

pnpm install --frozen-lockfile >> "$LOG" 2>&1
if [ $? -ne 0 ]; then
  echo "[$TS] ERROR: pnpm install failed" >> "$LOG"
fi

pnpm build >> "$LOG" 2>&1
if [ $? -ne 0 ]; then
  echo "[$TS] ERROR: pnpm build failed" >> "$LOG"
fi
`
      : `
npm update -g milo-bot-agent >> "$LOG" 2>&1
if [ $? -ne 0 ]; then
  echo "[$TS] ERROR: npm update failed" >> "$LOG"
fi
`;

  const script = `#!/bin/bash
LOG='${esc(logPath)}'
TS=$(date -u +%FT%TZ)
echo "[$TS] Update daemon started (agent PID: ${agentPid})" > "$LOG"

# Wait for agent to exit
while kill -0 ${agentPid} 2>/dev/null; do sleep 1; done
TS=$(date -u +%FT%TZ)
echo "[$TS] Agent exited, starting update..." >> "$LOG"

cd '${esc(packageRoot)}'
${updateSteps}
# Write restart script (.command files open in Terminal.app on macOS)
cat > '${esc(restartScriptPath)}' << 'MILO_RESTART_EOF'
#!/bin/bash
cd '${esc(packageRoot)}'
exec ${quotedStart}
MILO_RESTART_EOF
chmod +x '${esc(restartScriptPath)}'

# Restart agent
TS=$(date -u +%FT%TZ)
echo "[$TS] Restarting agent..." >> "$LOG"

if [[ "$(uname)" == "Darwin" ]]; then
  open '${esc(restartScriptPath)}' >> "$LOG" 2>&1
  if [ $? -eq 0 ]; then
    TS=$(date -u +%FT%TZ)
    echo "[$TS] Agent restarted in Terminal window" >> "$LOG"
  else
    nohup ${quotedStart} >> "$LOG" 2>&1 &
    AGENT_NEW_PID=$!
    TS=$(date -u +%FT%TZ)
    echo "[$TS] Terminal launch failed, agent restarted headless (PID: $AGENT_NEW_PID)" >> "$LOG"
  fi
else
  nohup ${quotedStart} >> "$LOG" 2>&1 &
  AGENT_NEW_PID=$!
  TS=$(date -u +%FT%TZ)
  echo "[$TS] Agent restarted headless (PID: $AGENT_NEW_PID)" >> "$LOG"
fi

# Cleanup daemon script
rm -f '${esc(scriptPath)}'
exit 0
`;

  writeFileSync(scriptPath, script, 'utf-8');
  chmodSync(scriptPath, 0o755);

  const child = spawn('bash', [scriptPath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

/**
 * Check the remote for the latest version.
 * Git: GitHub API for latest commit on master. npm: npm registry.
 */
export async function getLatestVersion(method: InstallMethod): Promise<string> {
  try {
    if (method === 'git') {
      const res = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/commits/master`,
        {
          headers: { Accept: 'application/vnd.github.v3+json' },
          signal: AbortSignal.timeout(10_000),
        }
      );
      if (!res.ok) return 'unknown';
      const data = await res.json() as { sha: string };
      return data.sha.slice(0, 7);
    }

    // npm registry
    const res = await fetch(
      `https://registry.npmjs.org/${NPM_PACKAGE}/latest`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return 'unknown';
    const data = await res.json() as { version: string };
    return data.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
