import { Type } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { readFileSync, existsSync, statSync } from 'fs';
import { basename, extname } from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SendFileToolDeps {
  sendFile: (opts: {
    filename: string;
    content: string;
    encoding: 'utf-8' | 'base64';
    mimeType: string;
    sizeBytes: number;
  }) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum file size in bytes (20KB — leaves room for base64 + JSON envelope within PubNub 32KB limit) */
export const MAX_FILE_SIZE = 20 * 1024;

/** Allowed text file extensions */
export const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.xml', '.html', '.htm', '.css',
  '.js', '.ts', '.jsx', '.tsx', '.csv', '.tsv',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.log',
  '.sh', '.bash', '.zsh', '.py', '.rb', '.go', '.rs',
  '.java', '.c', '.cpp', '.h', '.hpp', '.sql', '.graphql',
  '.env', '.gitignore', '.dockerfile', '.svg',
]);

/** Map file extensions to MIME types */
const MIME_MAP: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ts': 'text/x-typescript',
  '.jsx': 'text/javascript',
  '.tsx': 'text/x-typescript',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'text/x-toml',
  '.ini': 'text/plain',
  '.cfg': 'text/plain',
  '.conf': 'text/plain',
  '.log': 'text/plain',
  '.sh': 'text/x-shellscript',
  '.bash': 'text/x-shellscript',
  '.zsh': 'text/x-shellscript',
  '.py': 'text/x-python',
  '.rb': 'text/x-ruby',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.java': 'text/x-java',
  '.c': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.h': 'text/x-c',
  '.hpp': 'text/x-c++',
  '.sql': 'text/x-sql',
  '.graphql': 'text/x-graphql',
  '.env': 'text/plain',
  '.gitignore': 'text/plain',
  '.dockerfile': 'text/x-dockerfile',
  '.svg': 'image/svg+xml',
};

// ---------------------------------------------------------------------------
// Helpers (exported for testing)
// ---------------------------------------------------------------------------

export function getMimeType(ext: string): string {
  return MIME_MAP[ext.toLowerCase()] ?? 'text/plain';
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

const SendFileParams = Type.Object({
  filePath: Type.String({ description: 'Absolute path to the text file to send to the user' }),
});

export function createSendFileTool(deps: SendFileToolDeps): AgentTool<typeof SendFileParams> {
  return {
    name: 'send_file',
    label: 'Send File',
    description:
      'Send the contents of a text file to the user. ' +
      'Supports common text formats: source code, config files, JSON, XML, HTML, CSV, Markdown, etc. ' +
      'Maximum file size: 20KB. Binary files are not supported.',
    parameters: SendFileParams,
    execute: async (_toolCallId, params) => {
      const { filePath } = params;

      // Validate file exists
      if (!existsSync(filePath)) {
        return {
          content: [{ type: 'text' as const, text: `File not found: ${filePath}` }],
          details: { error: 'not_found' },
        };
      }

      // Validate extension
      let ext = extname(filePath).toLowerCase();
      if (!ext) {
        // Dotfiles like .gitignore have no extname — use the basename itself
        const name = basename(filePath).toLowerCase();
        if (name.startsWith('.') && TEXT_EXTENSIONS.has(name)) {
          ext = name;
        }
      }
      if (!ext || !TEXT_EXTENSIONS.has(ext)) {
        const supported = [...TEXT_EXTENSIONS].sort().join(', ');
        return {
          content: [{ type: 'text' as const, text: `"${basename(filePath)}" is not a supported text file type.\n\nSupported extensions: ${supported}` }],
          details: { error: 'unsupported_type' },
        };
      }

      // Validate size
      const stat = statSync(filePath);
      if (stat.size > MAX_FILE_SIZE) {
        const sizeKB = (stat.size / 1024).toFixed(1);
        const maxKB = (MAX_FILE_SIZE / 1024).toFixed(0);
        return {
          content: [{ type: 'text' as const, text: `File exceeds the ${maxKB}KB size limit (${sizeKB}KB). Consider sending a smaller file or a relevant excerpt.` }],
          details: { error: 'too_large', sizeBytes: stat.size },
        };
      }

      // Read and encode
      const buffer = readFileSync(filePath);
      let content: string;
      let encoding: 'utf-8' | 'base64';

      try {
        // Try UTF-8 decode — check for replacement characters indicating invalid UTF-8
        const text = buffer.toString('utf-8');
        if (text.includes('\uFFFD')) {
          content = buffer.toString('base64');
          encoding = 'base64';
        } else {
          content = text;
          encoding = 'utf-8';
        }
      } catch {
        content = buffer.toString('base64');
        encoding = 'base64';
      }

      const filename = basename(filePath);
      const mimeType = getMimeType(ext);

      // Send via IPC → PubNub
      deps.sendFile({
        filename,
        content,
        encoding,
        mimeType,
        sizeBytes: stat.size,
      });

      return {
        content: [{ type: 'text' as const, text: `Sent "${filename}" to the user (${(stat.size / 1024).toFixed(1)}KB, ${mimeType}).` }],
        details: { filename, mimeType, sizeBytes: stat.size, encoding },
      };
    },
  };
}
