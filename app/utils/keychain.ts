/**
 * OS Keychain Integration
 *
 * Uses native OS keychain via child_process.execFile — zero npm dependencies.
 * - macOS: security (Keychain Services)
 * - Windows: cmdkey.exe + PowerShell P/Invoke (advapi32.dll CredRead)
 * - Linux: secret-tool (libsecret)
 *
 * Falls back gracefully when keychain is unavailable.
 */

import { execFile } from 'child_process';
import { platform } from 'os';

const SERVICE_NAME = 'milo-bot';

/** Well-known account names */
const ACCOUNT_MILO_KEY = 'api-key';
const ACCOUNT_ANTHROPIC_KEY = 'anthropic-api-key';

/** Per-account in-memory cache so repeated loads don't spawn subprocesses */
const cache = new Map<string, string | null>();

function exec(cmd: string, args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() || error.message));
      } else {
        resolve(stdout.trim());
      }
    });
    if (stdin !== undefined && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------
const macOS = {
  async save(account: string, key: string): Promise<void> {
    await exec('security', [
      'add-generic-password',
      '-a', account,
      '-s', SERVICE_NAME,
      '-w', key,
      '-U', // update if exists
    ]);
  },

  async load(account: string): Promise<string | null> {
    try {
      const result = await exec('security', [
        'find-generic-password',
        '-a', account,
        '-s', SERVICE_NAME,
        '-w',
      ]);
      return result || null;
    } catch {
      return null;
    }
  },

  async delete(account: string): Promise<void> {
    try {
      await exec('security', [
        'delete-generic-password',
        '-a', account,
        '-s', SERVICE_NAME,
      ]);
    } catch {
      // Ignore if not found
    }
  },

  async probe(): Promise<boolean> {
    try {
      await exec('security', ['help']);
      return true;
    } catch {
      // security help exits non-zero but still prints to stderr
      try {
        await exec('which', ['security']);
        return true;
      } catch {
        return false;
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
const windows = {
  /** Windows credential target: combine service + account */
  target(account: string): string {
    return `${SERVICE_NAME}/${account}`;
  },

  async save(account: string, key: string): Promise<void> {
    const t = this.target(account);
    try {
      await exec('cmdkey.exe', [`/delete:${t}`]);
    } catch {
      // Ignore if not found
    }
    await exec('cmdkey.exe', [
      `/generic:${t}`,
      `/user:${account}`,
      `/pass:${key}`,
    ]);
  },

  async load(account: string): Promise<string | null> {
    const t = this.target(account);
    try {
      const psScript = `
Add-Type -Namespace Win32 -Name Cred -MemberDefinition @"
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr cred);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName;
    public string Comment; public long LastWritten; public int CredentialBlobSize;
    public IntPtr CredentialBlob; public int Persist; public int AttributeCount;
    public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
"@
[IntPtr]$ptr = [IntPtr]::Zero
if ([Win32.Cred]::CredRead("${t}",1,0,[ref]$ptr)) {
  $c = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [Type][Win32.Cred+CREDENTIAL])
  [Runtime.InteropServices.Marshal]::PtrToStringUni($c.CredentialBlob, $c.CredentialBlobSize/2)
  [Win32.Cred]::CredFree($ptr)
} else { "" }
`;
      const result = await exec('powershell.exe', ['-NoProfile', '-Command', psScript]);
      return result || null;
    } catch {
      return null;
    }
  },

  async delete(account: string): Promise<void> {
    try {
      await exec('cmdkey.exe', [`/delete:${this.target(account)}`]);
    } catch {
      // Ignore if not found
    }
  },

  async probe(): Promise<boolean> {
    try {
      await exec('cmdkey.exe', ['/list']);
      return true;
    } catch {
      return false;
    }
  },
};

// ---------------------------------------------------------------------------
// Linux (secret-tool / libsecret)
// ---------------------------------------------------------------------------
const linux = {
  async save(account: string, key: string): Promise<void> {
    await exec(
      'secret-tool',
      ['store', '--label=MiloBot Credential', 'service', SERVICE_NAME, 'account', account],
      key,
    );
  },

  async load(account: string): Promise<string | null> {
    try {
      const result = await exec('secret-tool', [
        'lookup',
        'service', SERVICE_NAME,
        'account', account,
      ]);
      return result || null;
    } catch {
      return null;
    }
  },

  async delete(account: string): Promise<void> {
    try {
      await exec('secret-tool', [
        'clear',
        'service', SERVICE_NAME,
        'account', account,
      ]);
    } catch {
      // Ignore if not found
    }
  },

  async probe(): Promise<boolean> {
    try {
      await exec('which', ['secret-tool']);
      return true;
    } catch {
      return false;
    }
  },
};

// ---------------------------------------------------------------------------
// Platform dispatch
// ---------------------------------------------------------------------------

function getBackend() {
  const os = platform();
  if (os === 'darwin') return macOS;
  if (os === 'win32') return windows;
  if (os === 'linux') return linux;
  return null;
}

// ---------------------------------------------------------------------------
// Generic credential operations (by account name)
// ---------------------------------------------------------------------------

async function saveCredential(account: string, key: string): Promise<void> {
  const backend = getBackend();
  if (!backend) throw new Error('Unsupported platform for keychain');
  await backend.save(account, key);
  cache.set(account, key);
}

async function loadCredential(account: string): Promise<string | null> {
  if (cache.has(account)) return cache.get(account) ?? null;

  const backend = getBackend();
  if (!backend) return null;

  const key = await backend.load(account);
  cache.set(account, key);
  return key;
}

async function deleteCredential(account: string): Promise<void> {
  const backend = getBackend();
  if (!backend) throw new Error('Unsupported platform for keychain');
  await backend.delete(account);
  cache.delete(account);
}

// ---------------------------------------------------------------------------
// MILO_API_KEY helpers
// ---------------------------------------------------------------------------

export async function saveApiKey(key: string): Promise<void> {
  return saveCredential(ACCOUNT_MILO_KEY, key);
}

export async function loadApiKey(): Promise<string | null> {
  return loadCredential(ACCOUNT_MILO_KEY);
}

export async function deleteApiKey(): Promise<void> {
  return deleteCredential(ACCOUNT_MILO_KEY);
}

// ---------------------------------------------------------------------------
// ANTHROPIC_API_KEY helpers
// ---------------------------------------------------------------------------

export async function saveAnthropicKey(key: string): Promise<void> {
  return saveCredential(ACCOUNT_ANTHROPIC_KEY, key);
}

export async function loadAnthropicKey(): Promise<string | null> {
  return loadCredential(ACCOUNT_ANTHROPIC_KEY);
}

export async function deleteAnthropicKey(): Promise<void> {
  return deleteCredential(ACCOUNT_ANTHROPIC_KEY);
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

/**
 * Check whether the OS keychain is available on this system.
 */
export async function isKeychainAvailable(): Promise<boolean> {
  const backend = getBackend();
  if (!backend) return false;
  try {
    return await backend.probe();
  } catch {
    return false;
  }
}

/**
 * Invalidate all in-memory caches (useful after external changes).
 */
export function clearKeychainCache(): void {
  cache.clear();
}
