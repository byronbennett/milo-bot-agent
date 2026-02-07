/**
 * List Files Tool
 *
 * Lists files in a directory with filtering options.
 */

import { join } from 'path';
import { registerTool } from '../registry';
import { listFiles, exists, isDirectory, getFileInfo } from '../../files';
import { logger } from '../../utils/logger';
import type { ToolMeta, ToolResult, ToolContext } from '../types';

const meta: ToolMeta = {
  name: 'list-files',
  description: 'List files in a directory with optional filtering',
  safe: true,
  aliases: ['ls', 'dir'],
  args: {
    path: {
      type: 'string',
      description: 'Directory path (defaults to current project)',
      required: false,
    },
    pattern: {
      type: 'string',
      description: 'Filter pattern (e.g., "*.ts")',
      required: false,
    },
    recursive: {
      type: 'boolean',
      description: 'List files recursively',
      default: false,
    },
    includeHidden: {
      type: 'boolean',
      description: 'Include hidden files (starting with .)',
      default: false,
    },
    detailed: {
      type: 'boolean',
      description: 'Show detailed file info (size, date)',
      default: false,
    },
  },
};

async function execute(
  args: Record<string, unknown>,
  context: ToolContext
): Promise<ToolResult> {
  const path = (args.path as string) || context.currentProject || context.workspaceDir;
  const pattern = args.pattern as string | undefined;
  const recursive = args.recursive === true;
  const includeHidden = args.includeHidden === true;
  const detailed = args.detailed === true;

  logger.debug(`Listing files in: ${path}`);

  // Check if path exists
  if (!exists(path)) {
    return {
      success: false,
      error: `Path does not exist: ${path}`,
    };
  }

  if (!isDirectory(path)) {
    return {
      success: false,
      error: `Not a directory: ${path}`,
    };
  }

  // Build filter function
  let filter: ((name: string) => boolean) | undefined;
  if (pattern) {
    const regex = patternToRegex(pattern);
    filter = (name: string) => regex.test(name);
  }

  // Get file list
  const files = listFiles(path, { filter, recursive, includeHidden });

  if (files.length === 0) {
    return {
      success: true,
      output: 'No files found',
      data: { count: 0, files: [] },
    };
  }

  // Format output
  let output: string;
  const fileData: Array<{
    name: string;
    size?: number;
    isDir?: boolean;
    modified?: string;
  }> = [];

  if (detailed) {
    const lines: string[] = [];
    for (const file of files) {
      const fullPath = join(path, file);
      const info = getFileInfo(fullPath);
      if (info) {
        const sizeStr = info.isDirectory ? '<DIR>' : formatSize(info.size);
        const dateStr = info.modifiedAt.toISOString().slice(0, 10);
        lines.push(`${dateStr}  ${sizeStr.padStart(10)}  ${file}`);
        fileData.push({
          name: file,
          size: info.size,
          isDir: info.isDirectory,
          modified: info.modifiedAt.toISOString(),
        });
      }
    }
    output = lines.join('\n');
  } else {
    output = files.join('\n');
    for (const file of files) {
      fileData.push({ name: file });
    }
  }

  return {
    success: true,
    output,
    data: { count: files.length, files: fileData },
  };
}

/**
 * Convert glob-like pattern to regex
 */
function patternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special chars
    .replace(/\*/g, '.*') // * -> .*
    .replace(/\?/g, '.'); // ? -> .

  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Format file size in human-readable format
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

// Register the tool
registerTool(meta, execute, 'built-in');

export { meta, execute };
