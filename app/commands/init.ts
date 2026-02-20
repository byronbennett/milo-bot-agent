import { Command } from 'commander';
import { input, confirm, select, password } from '@inquirer/prompts';
import open from 'open';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync, statSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { Logger } from '../utils/logger';
import {
  saveApiKey, loadApiKey,
  saveAnthropicKey, loadAnthropicKey, deleteAnthropicKey,
  saveOpenAIKey, loadOpenAIKey, deleteOpenAIKey,
  saveGeminiKey, loadGeminiKey, deleteGeminiKey,
  saveEncryptionPassword,
  isKeychainAvailable,
} from '../utils/keychain';
import {
  generateSalt,
  deriveKey,
  generateDEK,
  wrapDEK,
  computeVerifier,
} from '../crypto/encryption';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger = new Logger({ prefix: '[init]' });

const API_KEY_PATTERN = /^milo_[a-zA-Z0-9]+$/;
const ANTHROPIC_KEY_PATTERN = /^sk-ant-[a-zA-Z0-9_-]+$/;
const OPENAI_KEY_PATTERN = /^sk-/;
const GEMINI_KEY_PATTERN = /^AIza/;

const DEFAULT_AI_MODEL = 'claude-sonnet-4-6';

function validateApiKey(value: string): boolean | string {
  if (!value.trim()) return 'API key is required';
  if (!API_KEY_PATTERN.test(value.trim())) {
    return 'Invalid API key format. Keys start with "milo_"';
  }
  return true;
}

function validateAnthropicKey(value: string): boolean | string {
  if (!value.trim()) return 'API key is required';
  if (!ANTHROPIC_KEY_PATTERN.test(value.trim())) {
    return 'Invalid Anthropic API key format. Keys start with "sk-ant-"';
  }
  return true;
}

function validateOpenAIKey(value: string): boolean | string {
  if (!value.trim()) return 'API key is required';
  if (!OPENAI_KEY_PATTERN.test(value.trim())) {
    return 'Invalid OpenAI API key format. Keys start with "sk-"';
  }
  return true;
}

function validateGeminiKey(value: string): boolean | string {
  if (!value.trim()) return 'API key is required';
  if (!GEMINI_KEY_PATTERN.test(value.trim())) {
    return 'Invalid Gemini API key format. Keys start with "AIza"';
  }
  return true;
}

function expandPath(path: string): string {
  return path.replace(/^~/, homedir());
}

interface ExistingConfig {
  agentName?: string;
  ai?: {
    model?: string;
  };
  messaging?: {
    webapp?: {
      apiUrl?: string;
    };
  };
}

type KeySource = 'keychain' | 'env' | null;

interface ExistingState {
  config: ExistingConfig | null;
  apiKey: string | null;
  apiKeySource: KeySource;
  anthropicKey: string | null;
  anthropicKeySource: KeySource;
  openaiKey: string | null;
  openaiKeySource: KeySource;
  geminiKey: string | null;
  geminiKeySource: KeySource;
}

/**
 * Load existing config and keys from keychain or .env
 */
async function loadExisting(dir: string): Promise<ExistingState> {
  let config: ExistingConfig | null = null;
  let apiKey: string | null = null;
  let apiKeySource: KeySource = null;
  let anthropicKey: string | null = null;
  let anthropicKeySource: KeySource = null;
  let openaiKey: string | null = null;
  let openaiKeySource: KeySource = null;
  let geminiKey: string | null = null;
  let geminiKeySource: KeySource = null;

  const configPath = join(dir, 'config.json');
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      // Ignore parse errors
    }
  }

  // Try keychain first for all keys
  try {
    const keychainKey = await loadApiKey();
    if (keychainKey) {
      apiKey = keychainKey;
      apiKeySource = 'keychain';
    }
  } catch {
    // Keychain unavailable
  }

  try {
    const keychainKey = await loadAnthropicKey();
    if (keychainKey) {
      anthropicKey = keychainKey;
      anthropicKeySource = 'keychain';
    }
  } catch {
    // Keychain unavailable
  }

  try {
    const keychainKey = await loadOpenAIKey();
    if (keychainKey) {
      openaiKey = keychainKey;
      openaiKeySource = 'keychain';
    }
  } catch {
    // Keychain unavailable
  }

  try {
    const keychainKey = await loadGeminiKey();
    if (keychainKey) {
      geminiKey = keychainKey;
      geminiKeySource = 'keychain';
    }
  } catch {
    // Keychain unavailable
  }

  // Fall back to .env for any keys not found in keychain
  const envPath = join(dir, '.env');
  if (existsSync(envPath)) {
    try {
      const content = readFileSync(envPath, 'utf-8');

      if (!apiKey) {
        const match = content.match(/^MILO_API_KEY=(.+)$/m);
        if (match && match[1].trim()) {
          apiKey = match[1].trim();
          apiKeySource = 'env';
        }
      }

      if (!anthropicKey) {
        const match = content.match(/^ANTHROPIC_API_KEY=(.+)$/m);
        if (match && match[1].trim()) {
          anthropicKey = match[1].trim();
          anthropicKeySource = 'env';
        }
      }

      if (!openaiKey) {
        const match = content.match(/^OPENAI_API_KEY=(.+)$/m);
        if (match && match[1].trim()) {
          openaiKey = match[1].trim();
          openaiKeySource = 'env';
        }
      }

      if (!geminiKey) {
        const match = content.match(/^GEMINI_API_KEY=(.+)$/m);
        if (match && match[1].trim()) {
          geminiKey = match[1].trim();
          geminiKeySource = 'env';
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  return {
    config, apiKey, apiKeySource, anthropicKey, anthropicKeySource,
    openaiKey, openaiKeySource, geminiKey, geminiKeySource,
  };
}

function maskKey(key: string): string {
  return key.slice(0, 8) + '...' + key.slice(-4);
}

/**
 * Prompt the user for a secret key, with keychain migration support.
 *
 * Returns the final key value (or undefined if skipped).
 */
async function promptForKey(opts: {
  label: string;
  existingKey: string | null;
  existingSource: KeySource;
  validate: (v: string) => boolean | string;
  save: (k: string) => Promise<void>;
  /** Delete from keychain. Required when required=false to support removal. */
  deleteFromKeychain?: () => Promise<void>;
  envName: string;
  resolvedDir: string;
  isInteractive: boolean;
  cliValue?: string;
  /** When false, allows the user to skip entering or remove the key. Defaults to true. */
  required?: boolean;
}): Promise<string | undefined> {
  const { label, existingKey, existingSource, validate, save, deleteFromKeychain, envName, resolvedDir, isInteractive, cliValue, required = true } = opts;

  // CLI flag takes precedence
  if (cliValue) {
    const v = validate(cliValue);
    if (v !== true) {
      logger.error(v as string);
      process.exit(1);
    }
    return cliValue.trim();
  }

  if (!isInteractive) return existingKey ?? undefined;

  if (existingKey) {
    const sourceLabel = existingSource === 'keychain' ? ' (system keychain)' : ' (.env file)';

    // Optional keys: offer Keep / Change / Remove
    if (!required) {
      const action = await select({
        message: `${label} is set${sourceLabel} (${maskKey(existingKey)}).`,
        choices: [
          { name: 'Keep current key', value: 'keep' as const },
          { name: 'Change key', value: 'change' as const },
          { name: 'Remove key', value: 'remove' as const },
        ],
        default: 'keep' as const,
      });

      if (action === 'remove') {
        // Remove from keychain if stored there
        if (existingSource === 'keychain' && deleteFromKeychain) {
          try {
            await deleteFromKeychain();
          } catch (err) {
            logger.warn(`Failed to remove from keychain: ${err}`);
          }
        }
        // Remove from .env
        removeEnvVar(resolvedDir, envName);
        console.log(`   ${label} removed`);
        return undefined;
      }

      if (action === 'change') {
        let newKey = await input({ message: `Enter your new ${label}:`, validate });
        return newKey.trim();
      }

      // Keep — offer migration if in .env
      if (existingSource === 'env') {
        const keychainOk = await isKeychainAvailable();
        if (keychainOk) {
          const migrate = await confirm({
            message: `Migrate ${label} from .env to system keychain (more secure)?`,
            default: true,
          });
          if (migrate) {
            try {
              await save(existingKey);
              removeEnvVar(resolvedDir, envName);
              console.log(`🔑 ${label} migrated to system keychain`);
            } catch (err) {
              logger.warn(`Failed to migrate to keychain: ${err}`);
            }
          }
        }
      }

      return existingKey;
    }

    // Required keys: simple Change? confirm
    const changeKey = await confirm({
      message: `${label} already set${sourceLabel} (${maskKey(existingKey)}). Change it?`,
      default: false,
    });

    if (changeKey) {
      let newKey = await input({ message: `Enter your new ${label}:`, validate });
      return newKey.trim();
    }

    // Offer to migrate from .env to keychain
    if (existingSource === 'env') {
      const keychainOk = await isKeychainAvailable();
      if (keychainOk) {
        const migrate = await confirm({
          message: `Migrate ${label} from .env to system keychain (more secure)?`,
          default: true,
        });
        if (migrate) {
          try {
            await save(existingKey);
            removeEnvVar(resolvedDir, envName);
            console.log(`🔑 ${label} migrated to system keychain`);
          } catch (err) {
            logger.warn(`Failed to migrate to keychain: ${err}`);
          }
        }
      }
    }

    return existingKey;
  }

  // No existing key — if optional, let the user skip
  if (!required) {
    const wantKey = await confirm({
      message: `Do you want to add a ${label}?`,
      default: false,
    });
    if (!wantKey) return undefined;
  }

  let newKey = await input({ message: `Enter your ${label}:`, validate });
  return newKey.trim();
}

/**
 * Remove a specific env var from the .env file (rewrite without it).
 */
function removeEnvVar(dir: string, varName: string): void {
  const envPath = join(dir, '.env');
  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, 'utf-8');
  const lines = content.split('\n');
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    return !trimmed.startsWith(`${varName}=`);
  });
  writeFileSync(envPath, filtered.join('\n'));
}

/**
 * Save a secret: try keychain, fall back to appending to .env.
 * Returns 'keychain' or 'env' depending on where it ended up.
 */
async function saveSecret(opts: {
  key: string;
  save: (k: string) => Promise<void>;
  envName: string;
  resolvedDir: string;
  label: string;
}): Promise<'keychain' | 'env'> {
  const { key, save, envName, resolvedDir, label } = opts;

  try {
    const keychainOk = await isKeychainAvailable();
    if (keychainOk) {
      await save(key);
      // Make sure .env doesn't also have the plain text key
      removeEnvVar(resolvedDir, envName);
      console.log(`🔑 ${label} saved to system keychain`);
      return 'keychain';
    }
  } catch (err) {
    logger.warn(`Keychain save failed, falling back to .env: ${err}`);
  }

  // Fall back to .env
  appendEnvVar(resolvedDir, envName, key);
  console.log(`🔑 ${label} saved to .env file`);
  return 'env';
}

/**
 * Set an env var in the .env file (replace if exists, append if not).
 */
function appendEnvVar(dir: string, varName: string, value: string): void {
  const envPath = join(dir, '.env');

  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    const re = new RegExp(`^${varName}=.*$`, 'm');
    if (re.test(content)) {
      writeFileSync(envPath, content.replace(re, `${varName}=${value}`));
    } else {
      writeFileSync(envPath, content.trimEnd() + `\n${varName}=${value}\n`);
    }
  } else {
    writeFileSync(envPath, `${varName}=${value}\n`);
  }
}

/**
 * Extract the server base URL from a stored apiUrl (strip trailing /api)
 */
function extractServerUrl(apiUrl: string): string {
  return apiUrl.replace(/\/api\/?$/, '');
}

/**
 * Run the init flow programmatically.
 * Accepts the same options object that commander would pass.
 */
export async function runInit(options: {
  apiKey?: string;
  anthropicKey?: string;
  openaiKey?: string;
  geminiKey?: string;
  aiModel?: string;
  dir?: string;
  name?: string;
  serverUrl?: string;
  yes?: boolean;
  browser?: boolean;
} = {}): Promise<void> {
    console.log('');
    console.log('🤖 Welcome to MiloBot Setup!');
    console.log('');

    const isInteractive = !options.yes && process.stdout.isTTY;

    // Determine workspace directory
    let workspaceDir: string;
    if (options.dir) {
      workspaceDir = expandPath(options.dir);
    } else if (isInteractive) {
      const dirInput = await input({
        message: 'Where should I create your workspace?',
        default: '~/milo-workspace',
      });
      workspaceDir = expandPath(dirInput);
    } else {
      workspaceDir = expandPath('~/milo-workspace');
    }
    const resolvedDir = resolve(workspaceDir);

    // Check if already initialized and load existing values
    const configPath = join(resolvedDir, 'config.json');
    const isReinit = existsSync(configPath);
    let existing: ExistingState = {
      config: null, apiKey: null, apiKeySource: null,
      anthropicKey: null, anthropicKeySource: null,
      openaiKey: null, openaiKeySource: null,
      geminiKey: null, geminiKeySource: null,
    };

    if (isReinit) {
      existing = await loadExisting(resolvedDir);

      if (isInteractive) {
        const reinit = await confirm({
          message: `Workspace already exists at ${resolvedDir}. Reconfigure?`,
          default: true,
        });
        if (!reinit) {
          console.log('Setup cancelled.');
          return;
        }
      } else {
        logger.warn(`Workspace already exists at ${resolvedDir}`);
        logger.info('Use --yes to reinitialize or specify a different directory with --dir');
        return;
      }
    }

    // Determine agent name
    const existingName = existing.config?.agentName || 'Milo';
    let agentName: string;
    if (options.name) {
      agentName = options.name.trim();
    } else if (isInteractive) {
      agentName = await input({
        message: 'What should I call this agent?',
        default: existingName,
      });
    } else {
      agentName = existingName;
    }

    // Determine server URL
    const existingServerUrl = existing.config?.messaging?.webapp?.apiUrl
      ? extractServerUrl(existing.config.messaging.webapp.apiUrl)
      : 'https://www.milobot.dev';
    let serverUrl: string;
    if (options.serverUrl) {
      serverUrl = options.serverUrl.replace(/\/+$/, '');
    } else if (isInteractive) {
      const urlInput = await input({
        message: 'Server URL (your MiloBot server):',
        default: existingServerUrl,
      });
      serverUrl = urlInput.trim().replace(/\/+$/, '');
    } else {
      serverUrl = existingServerUrl;
    }

    // -----------------------------------------------------------------------
    // MiloBot API key
    // -----------------------------------------------------------------------
    let apiKey: string | undefined;
    if (options.apiKey) {
      const validation = validateApiKey(options.apiKey);
      if (validation !== true) {
        logger.error(validation as string);
        process.exit(1);
      }
      apiKey = options.apiKey.trim();
    } else if (isInteractive) {
      if (existing.apiKey) {
        apiKey = await promptForKey({
          label: 'MiloBot API key',
          existingKey: existing.apiKey,
          existingSource: existing.apiKeySource,
          validate: validateApiKey,
          save: saveApiKey,
          envName: 'MILO_API_KEY',
          resolvedDir,
          isInteractive,
        });
      } else {
        const hasKey = await confirm({
          message: `Do you have an API key from ${serverUrl}?`,
          default: false,
        });

        if (hasKey) {
          apiKey = await input({
            message: 'Enter your API key:',
            validate: validateApiKey,
          });
          apiKey = apiKey.trim();
        } else {
          console.log('');
          console.log(`📋 Get your API key from: ${serverUrl}/settings`);

          if (options.browser !== false) {
            console.log('   Opening browser...');
            try {
              await open(`${serverUrl}/settings`);
            } catch {
              // Browser failed to open, continue anyway
            }
          }

          console.log('');
          apiKey = await input({
            message: 'Enter your API key when ready:',
            validate: validateApiKey,
          });
          apiKey = apiKey.trim();
        }
      }
    }

    // -----------------------------------------------------------------------
    // AI Provider API Keys
    // -----------------------------------------------------------------------
    console.log('');
    console.log('🧠 AI Provider API Keys');
    console.log('   MiloBot can use models from Anthropic, OpenAI, and Google.');
    console.log('   At least one provider key is needed for AI features (intent');
    console.log('   parsing, prompt enhancement, auto-answer, and agent tasks).');
    console.log('');
    console.log('   Important: Using these APIs incurs costs based on token usage.');
    console.log('   MiloBot is designed to use tokens sparingly, but there will be');
    console.log('   a cost. By providing your API keys, you accept responsibility');
    console.log('   for any charges. Your keys are only sent to their respective');
    console.log('   providers as part of API requests — they are never shared with');
    console.log('   any other service.');
    console.log('');

    let anthropicKey: string | undefined;
    let openaiKey: string | undefined;
    let geminiKey: string | undefined;

    // For new setups (no existing keys, no CLI flags), require explicit acceptance
    const hasAnyExistingProviderKey = existing.anthropicKey || existing.openaiKey || existing.geminiKey;
    const hasAnyCliProviderKey = options.anthropicKey || options.openaiKey || options.geminiKey;
    let acceptedTerms = true;
    if (isInteractive && !hasAnyExistingProviderKey && !hasAnyCliProviderKey) {
      acceptedTerms = await confirm({
        message: 'I understand that AI API usage incurs costs and accept this term.',
        default: true,
      });
      if (!acceptedTerms) {
        console.log('');
        console.log('   Skipping AI provider key setup. You can add keys later with `milo init`.');
      }
    }

    if (acceptedTerms) {
      // --- Anthropic ---
      console.log('');
      console.log('🔑 Anthropic API Key (optional)');
      console.log('   Enables Claude models for agent tasks.');
      console.log('   Get an API key: https://console.anthropic.com/settings/keys');
      console.log('');

      anthropicKey = await promptForKey({
        label: 'Anthropic API key',
        existingKey: existing.anthropicKey,
        existingSource: existing.anthropicKeySource,
        validate: validateAnthropicKey,
        save: saveAnthropicKey,
        deleteFromKeychain: deleteAnthropicKey,
        envName: 'ANTHROPIC_API_KEY',
        resolvedDir,
        isInteractive,
        cliValue: options.anthropicKey,
        required: false,
      });

      // --- OpenAI ---
      console.log('');
      console.log('🔑 OpenAI API Key (optional)');
      console.log('   Enables OpenAI models (GPT-4, o1, etc.) for agent tasks.');
      console.log('   Get an API key: https://platform.openai.com/api-keys');
      console.log('');

      openaiKey = await promptForKey({
        label: 'OpenAI API key',
        existingKey: existing.openaiKey,
        existingSource: existing.openaiKeySource,
        validate: validateOpenAIKey,
        save: saveOpenAIKey,
        deleteFromKeychain: deleteOpenAIKey,
        envName: 'OPENAI_API_KEY',
        resolvedDir,
        isInteractive,
        cliValue: options.openaiKey,
        required: false,
      });

      // --- Gemini ---
      console.log('');
      console.log('🔑 Gemini API Key (optional)');
      console.log('   Enables Google Gemini models for agent tasks.');
      console.log('   Get an API key: https://aistudio.google.com/apikey');
      console.log('');

      geminiKey = await promptForKey({
        label: 'Gemini API key',
        existingKey: existing.geminiKey,
        existingSource: existing.geminiKeySource,
        validate: validateGeminiKey,
        save: saveGeminiKey,
        deleteFromKeychain: deleteGeminiKey,
        envName: 'GEMINI_API_KEY',
        resolvedDir,
        isInteractive,
        cliValue: options.geminiKey,
        required: false,
      });
    }

    // -----------------------------------------------------------------------
    // AI model selection
    // -----------------------------------------------------------------------
    const existingModel = existing.config?.ai?.model || DEFAULT_AI_MODEL;
    let aiModel: string;
    if (options.aiModel) {
      aiModel = options.aiModel.trim();
    } else if (isInteractive) {
      aiModel = await select({
        message: 'Which model should Milo use for AI calls?',
        choices: [
          { name: 'Claude Sonnet 4.6 (recommended)', value: 'claude-sonnet-4-6' },
          { name: 'Claude Haiku 4.5 (faster, cheaper)', value: 'claude-haiku-4-5' },
          { name: 'Claude Opus 4.6 (most capable)', value: 'claude-opus-4-6' },
          { name: 'Custom model ID...', value: '__custom__' },
        ],
        default: existingModel,
      });

      if (aiModel === '__custom__') {
        console.log('');
        console.log('📋 See available models: https://platform.claude.com/docs/en/about-claude/models/overview');
        console.log('');
        aiModel = await input({
          message: 'Enter the model ID:',
          default: existingModel,
        });
        aiModel = aiModel.trim();
      }
    } else {
      aiModel = existingModel;
    }

    // -----------------------------------------------------------------------
    // Encryption setup
    // -----------------------------------------------------------------------
    let encryptionLevel = 1;
    let encryptionSalt: string | undefined;
    let encryptionWrappedDEK: string | undefined;
    let encryptionWrappedDEKIV: string | undefined;
    let encryptionVerifier: string | undefined;
    let encryptionPasswordValue: string | undefined;

    if (isInteractive) {
      console.log('');
      console.log('🔒 Message Encryption');
      console.log('   Control how messages between you and the agent are protected.');
      console.log('');

      encryptionLevel = await select({
        message: 'Choose an encryption level:',
        choices: [
          { name: 'None — messages stored in plaintext', value: 1 },
          { name: 'Server-Managed — password stored securely on server', value: 2 },
          { name: 'End-to-End — zero-knowledge, password never leaves your machine', value: 3 },
        ],
        default: 1,
      });

      if (encryptionLevel >= 2) {
        console.log('');
        const encPassword = await password({
          message: 'Enter an encryption password:',
          mask: '*',
        });

        const encPasswordConfirm = await password({
          message: 'Confirm encryption password:',
          mask: '*',
        });

        if (encPassword !== encPasswordConfirm) {
          logger.error('Passwords do not match. Aborting setup.');
          process.exit(1);
        }

        if (encryptionLevel === 3) {
          console.log('');
          console.log('   ⚠️  End-to-End encryption means your password NEVER leaves this');
          console.log('   machine. If you lose it, your encrypted messages CANNOT be recovered.');
          console.log('');
          const e2eConfirm = await confirm({
            message: 'I understand there is no password recovery. Continue?',
            default: false,
          });
          if (!e2eConfirm) {
            console.log('Encryption setup cancelled. Falling back to no encryption.');
            encryptionLevel = 1;
          }
        }

        // Generate crypto materials if still level 2 or 3
        if (encryptionLevel >= 2) {
          encryptionPasswordValue = encPassword;
          const salt = generateSalt();
          const masterKey = deriveKey(encPassword, salt);
          const dek = generateDEK();
          const { wrapped, iv } = wrapDEK(dek, masterKey);

          encryptionSalt = salt.toString('base64');
          encryptionWrappedDEK = wrapped;
          encryptionWrappedDEKIV = iv;
          encryptionVerifier = computeVerifier(masterKey);

          // Save password to keychain
          try {
            await saveSecret({
              key: encPassword,
              save: saveEncryptionPassword,
              envName: 'MILO_ENCRYPTION_PASSWORD',
              resolvedDir,
              label: 'Encryption password',
            });
          } catch (err) {
            logger.warn(`Failed to save encryption password: ${err}`);
          }
        }
      }
    }

    // -----------------------------------------------------------------------
    // Create workspace
    // -----------------------------------------------------------------------
    console.log('');
    if (isReinit) {
      console.log(`📁 Updating workspace at ${resolvedDir}...`);
    } else {
      console.log(`📁 Creating workspace at ${resolvedDir}...`);
    }
    mkdirSync(resolvedDir, { recursive: true });

    // Create directory structure
    const dirs = ['SESSIONS', 'SESSIONS/archive', 'PROJECTS', 'templates', 'TOOLS', 'SKILLS', 'logs', 'PERSONAS'];
    for (const dir of dirs) {
      mkdirSync(join(resolvedDir, dir), { recursive: true });
    }

    // Create initial files only if they don't already exist
    const files: Record<string, string> = {
      'MEMORY.md': `# Agent Memory

> Long-term preferences and learnings for the agent.

## User Preferences

- [Add your preferences here]

## Common Patterns

- [Patterns the agent should remember]

## Project Notes

- [Notes about your projects]
`,
      'RULES.md': `# Auto-Answer Rules

> Rules for automatically answering Claude Code questions.

## Global Rules

When Claude Code asks about folder permissions, answer "yes".
When Claude Code asks about creating directories, answer "yes".
When Claude Code asks about installing dependencies, answer "yes".

## Dangerous Operations

When Claude Code asks about force pushing, ask the user.
When Claude Code asks about deleting files, ask the user.
When Claude Code asks about modifying system files, ask the user.
`,
      'templates/README.md': `# Project Name

> A brief description of the project.

## Getting Started

\`\`\`bash
# Install dependencies
npm install

# Start development server
npm run dev
\`\`\`

## License

MIT
`,
      'templates/.gitignore': `# Dependencies
node_modules/

# Build outputs
dist/
.next/

# Environment
.env
.env.local

# IDE
.vscode/
.idea/

# OS
.DS_Store
`,
    };

    for (const [filename, content] of Object.entries(files)) {
      const filePath = join(resolvedDir, filename);
      if (!existsSync(filePath)) {
        writeFileSync(filePath, content);
      }
    }

    // Create .gitkeep files
    const gitkeepDirs = ['SESSIONS/archive', 'PROJECTS', 'TOOLS', 'SKILLS', 'logs'];
    for (const dir of gitkeepDirs) {
      const gitkeepPath = join(resolvedDir, dir, '.gitkeep');
      if (!existsSync(gitkeepPath)) {
        writeFileSync(gitkeepPath, '');
      }
    }

    // Copy default skills if SKILLS dir is empty
    const defaultSkillsSrc = join(__dirname, '..', 'templates', 'SKILLS');
    const workspaceSkillsDir = join(resolvedDir, 'SKILLS');
    if (existsSync(defaultSkillsSrc)) {
      const existingSkills = existsSync(workspaceSkillsDir)
        ? readdirSync(workspaceSkillsDir).filter((f) => f !== '.gitkeep')
        : [];
      if (existingSkills.length === 0) {
        mkdirSync(workspaceSkillsDir, { recursive: true });
        const defaultSkills = readdirSync(defaultSkillsSrc);
        for (const skill of defaultSkills) {
          const srcPath = join(defaultSkillsSrc, skill);
          if (statSync(srcPath).isFile()) {
            copyFileSync(srcPath, join(workspaceSkillsDir, skill));
          }
        }
      }
    }

    // Copy DEFAULT-CLAUDE.md to workspace templates if not present
    const defaultClaudeMdSrc = join(__dirname, '..', 'templates', 'DEFAULT-CLAUDE.md');
    const workspaceTemplatesDir = join(resolvedDir, 'templates');
    const destClaudeMd = join(workspaceTemplatesDir, 'DEFAULT-CLAUDE.md');
    if (existsSync(defaultClaudeMdSrc) && !existsSync(destClaudeMd)) {
      mkdirSync(workspaceTemplatesDir, { recursive: true });
      copyFileSync(defaultClaudeMdSrc, destClaudeMd);
    }

    // Create config
    const config = {
      agentName,
      agentId: '',
      aliases: {
        CC: 'Claude Code',
        claude: 'Claude Code',
      },
      workspace: {
        baseDir: resolvedDir,
        projectsDir: 'PROJECTS',
        sessionsDir: 'SESSIONS',
        templatesDir: 'templates',
        toolsDir: 'TOOLS',
        skillsDir: 'SKILLS',
        personasDir: 'PERSONAS',
      },
      claudeCode: {
        maxConcurrentSessions: 3,
        startupMaxRetries: 5,
        startupRetryIntervalSeconds: 30,
      },
      scheduler: {
        heartbeatIntervalMinutes: 3,
        userNotificationThrottleMinutes: 20,
      },
      tasks: {
        maxRetries: 3,
      },
      tools: {
        safeTools: ['create-project', 'init-git-repo', 'list-files'],
        requireConfirmation: ['delete-project', 'force-push'],
      },
      ai: {
        model: aiModel,
      },
      encryption: {
        level: encryptionLevel,
        ...(encryptionSalt && {
          salt: encryptionSalt,
          wrappedDEK: encryptionWrappedDEK,
          wrappedDEKIV: encryptionWrappedDEKIV,
        }),
      },
      messaging: {
        activeAdapter: 'webapp',
        webapp: {
          apiUrl: `${serverUrl}/api`,
          pollIntervalMs: 180000,
        },
        telegram: {
          enabled: false,
        },
      },
      onboardingComplete: !!apiKey,
    };

    // -----------------------------------------------------------------------
    // Save secrets
    // -----------------------------------------------------------------------

    // Ensure .env exists before we start saving
    const envPath = join(resolvedDir, '.env');
    if (!existsSync(envPath)) {
      writeFileSync(envPath, '# MiloBot environment\n');
    }

    if (apiKey) {
      await saveSecret({
        key: apiKey,
        save: saveApiKey,
        envName: 'MILO_API_KEY',
        resolvedDir,
        label: 'MiloBot API key',
      });
    }

    if (anthropicKey) {
      await saveSecret({
        key: anthropicKey,
        save: saveAnthropicKey,
        envName: 'ANTHROPIC_API_KEY',
        resolvedDir,
        label: 'Anthropic API key',
      });
    }

    if (openaiKey) {
      await saveSecret({
        key: openaiKey,
        save: saveOpenAIKey,
        envName: 'OPENAI_API_KEY',
        resolvedDir,
        label: 'OpenAI API key',
      });
    }

    if (geminiKey) {
      await saveSecret({
        key: geminiKey,
        save: saveGeminiKey,
        envName: 'GEMINI_API_KEY',
        resolvedDir,
        label: 'Gemini API key',
      });
    }

    // Write config
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    // Sync encryption settings to server
    if (encryptionLevel > 1 && apiKey) {
      try {
        const response = await fetch(`${serverUrl}/api/agent/encryption`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
          },
          body: JSON.stringify({
            level: encryptionLevel,
            salt: encryptionSalt,
            verifier: encryptionVerifier,
            wrappedDEK: encryptionWrappedDEK,
            wrappedDEKIV: encryptionWrappedDEKIV,
            ...(encryptionLevel === 2 && { password: encryptionPasswordValue }),
          }),
        });
        if (response.ok) {
          console.log('🔒 Encryption settings synced to server');
        } else {
          const body = await response.text();
          logger.warn(`Failed to sync encryption settings: ${response.status} ${body}`);
        }
      } catch (err) {
        logger.warn(`Failed to sync encryption settings: ${err}`);
      }
    }

    if (isReinit) {
      console.log('✅ Workspace updated successfully!');
    } else {
      console.log('✅ Workspace created successfully!');
    }
    console.log('');

    console.log(`🧠 AI model: ${aiModel}`);

    if (apiKey && anthropicKey) {
      console.log('🚀 Next: Run `milo start` to connect your agent');
    } else {
      console.log('Next steps:');
      if (!apiKey) {
        console.log(`  1. Get an API key from ${serverUrl}/settings`);
      }
      if (!anthropicKey) {
        console.log(`  ${!apiKey ? '2' : '1'}. Get an Anthropic API key from https://console.anthropic.com/`);
      }
      console.log(`  ${!apiKey && !anthropicKey ? '3' : '2'}. Run \`milo init\` again to add missing keys`);
      console.log(`  ${!apiKey && !anthropicKey ? '4' : '3'}. Run \`milo start\` to connect your agent`);
    }
    console.log('');
}

export const initCommand = new Command('init')
  .description('Initialize MiloBot agent workspace')
  .option('-s, --server-url <url>', 'MiloBot server URL (default: https://www.milobot.dev)')
  .option('-k, --api-key <key>', 'MiloBot API key')
  .option('--anthropic-key <key>', 'Anthropic API key for Milo AI features')
  .option('--openai-key <key>', 'OpenAI API key (enables GPT models)')
  .option('--gemini-key <key>', 'Gemini API key (enables Google Gemini models)')
  .option('--ai-model <model>', 'Model for Milo AI calls (not Claude Code)')
  .option('-d, --dir <directory>', 'Workspace directory')
  .option('-n, --name <name>', 'Agent name')
  .option('-y, --yes', 'Use defaults, non-interactive mode')
  .option('--no-browser', 'Skip opening browser for API key')
  .action(runInit);
