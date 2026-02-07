/**
 * File Manager
 *
 * File and directory operations for the agent.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  statSync,
  copyFileSync,
  rmSync,
} from 'fs';
import { join, dirname, basename } from 'path';
import { logger } from '../utils/logger';

/**
 * Create a directory recursively
 *
 * @param dirPath - Path to create
 * @returns True if created or already exists
 */
export function createDirectory(dirPath: string): boolean {
  try {
    if (existsSync(dirPath)) {
      return true;
    }
    mkdirSync(dirPath, { recursive: true });
    logger.debug(`Created directory: ${dirPath}`);
    return true;
  } catch (error) {
    logger.error(`Failed to create directory ${dirPath}:`, error);
    return false;
  }
}

/**
 * Create a file with content
 *
 * @param filePath - Path to the file
 * @param content - File content
 * @returns True if successful
 */
export function createFile(filePath: string, content: string = ''): boolean {
  try {
    // Ensure parent directory exists
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      createDirectory(dir);
    }

    writeFileSync(filePath, content, 'utf-8');
    logger.debug(`Created file: ${filePath}`);
    return true;
  } catch (error) {
    logger.error(`Failed to create file ${filePath}:`, error);
    return false;
  }
}

/**
 * Read a file's content
 *
 * @param filePath - Path to the file
 * @returns File content or null if failed
 */
export function readFile(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) {
      logger.warn(`File not found: ${filePath}`);
      return null;
    }
    return readFileSync(filePath, 'utf-8');
  } catch (error) {
    logger.error(`Failed to read file ${filePath}:`, error);
    return null;
  }
}

/**
 * Write content to a file
 *
 * @param filePath - Path to the file
 * @param content - Content to write
 * @returns True if successful
 */
export function writeFile(filePath: string, content: string): boolean {
  try {
    writeFileSync(filePath, content, 'utf-8');
    logger.debug(`Wrote to file: ${filePath}`);
    return true;
  } catch (error) {
    logger.error(`Failed to write file ${filePath}:`, error);
    return false;
  }
}

/**
 * Delete a file or directory
 *
 * @param path - Path to delete
 * @param recursive - If true, delete directories recursively
 * @returns True if successful
 */
export function deleteFile(path: string, recursive = false): boolean {
  try {
    if (!existsSync(path)) {
      return true; // Already deleted
    }

    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (recursive) {
        rmSync(path, { recursive: true });
      } else {
        logger.warn(`Cannot delete non-empty directory without recursive: ${path}`);
        return false;
      }
    } else {
      unlinkSync(path);
    }

    logger.debug(`Deleted: ${path}`);
    return true;
  } catch (error) {
    logger.error(`Failed to delete ${path}:`, error);
    return false;
  }
}

/**
 * Check if a path exists
 *
 * @param path - Path to check
 * @returns True if exists
 */
export function exists(path: string): boolean {
  return existsSync(path);
}

/**
 * Check if path is a directory
 *
 * @param path - Path to check
 * @returns True if directory
 */
export function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * List files in a directory
 *
 * @param dirPath - Directory path
 * @param options - List options
 * @returns Array of file names
 */
export function listFiles(
  dirPath: string,
  options: {
    filter?: (name: string) => boolean;
    includeHidden?: boolean;
    recursive?: boolean;
  } = {}
): string[] {
  const { filter, includeHidden = false, recursive = false } = options;

  if (!existsSync(dirPath) || !isDirectory(dirPath)) {
    return [];
  }

  try {
    const entries = readdirSync(dirPath);
    let results: string[] = [];

    for (const entry of entries) {
      // Skip hidden files unless requested
      if (!includeHidden && entry.startsWith('.')) {
        continue;
      }

      const fullPath = join(dirPath, entry);
      const isDir = isDirectory(fullPath);

      // Apply filter
      if (filter && !filter(entry)) {
        continue;
      }

      if (recursive && isDir) {
        const subFiles = listFiles(fullPath, options);
        results = results.concat(subFiles.map((f) => join(entry, f)));
      }

      results.push(entry);
    }

    return results.sort();
  } catch (error) {
    logger.error(`Failed to list files in ${dirPath}:`, error);
    return [];
  }
}

/**
 * Copy a file
 *
 * @param src - Source path
 * @param dest - Destination path
 * @returns True if successful
 */
export function copyFile(src: string, dest: string): boolean {
  try {
    // Ensure destination directory exists
    const destDir = dirname(dest);
    if (!existsSync(destDir)) {
      createDirectory(destDir);
    }

    copyFileSync(src, dest);
    logger.debug(`Copied ${src} to ${dest}`);
    return true;
  } catch (error) {
    logger.error(`Failed to copy ${src} to ${dest}:`, error);
    return false;
  }
}

/**
 * Copy a directory recursively
 *
 * @param srcDir - Source directory
 * @param destDir - Destination directory
 * @returns True if successful
 */
export function copyDirectory(srcDir: string, destDir: string): boolean {
  try {
    if (!existsSync(srcDir)) {
      logger.warn(`Source directory not found: ${srcDir}`);
      return false;
    }

    createDirectory(destDir);

    const entries = readdirSync(srcDir);
    for (const entry of entries) {
      const srcPath = join(srcDir, entry);
      const destPath = join(destDir, entry);

      if (isDirectory(srcPath)) {
        copyDirectory(srcPath, destPath);
      } else {
        copyFile(srcPath, destPath);
      }
    }

    logger.debug(`Copied directory ${srcDir} to ${destDir}`);
    return true;
  } catch (error) {
    logger.error(`Failed to copy directory ${srcDir}:`, error);
    return false;
  }
}

/**
 * Get file info
 *
 * @param path - File path
 * @returns File info or null
 */
export function getFileInfo(path: string): {
  name: string;
  size: number;
  isDirectory: boolean;
  modifiedAt: Date;
} | null {
  try {
    if (!existsSync(path)) {
      return null;
    }

    const stat = statSync(path);
    return {
      name: basename(path),
      size: stat.size,
      isDirectory: stat.isDirectory(),
      modifiedAt: stat.mtime,
    };
  } catch {
    return null;
  }
}
