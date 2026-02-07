/**
 * Template Handling
 *
 * Manages project templates and file generation.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { logger } from '../utils/logger';
import { createDirectory, copyFile, copyDirectory, isDirectory } from './manager';

/**
 * Template variables for substitution
 */
export interface TemplateVars {
  projectName?: string;
  description?: string;
  author?: string;
  year?: number;
  [key: string]: string | number | undefined;
}

/**
 * Copy a template directory to a destination with variable substitution
 *
 * @param templateDir - Source template directory
 * @param destDir - Destination directory
 * @param vars - Template variables
 * @returns True if successful
 */
export function copyTemplate(
  templateDir: string,
  destDir: string,
  vars: TemplateVars = {}
): boolean {
  if (!existsSync(templateDir)) {
    logger.warn(`Template directory not found: ${templateDir}`);
    return false;
  }

  try {
    createDirectory(destDir);

    const entries = readdirSync(templateDir);

    for (const entry of entries) {
      const srcPath = join(templateDir, entry);
      const destName = substituteVars(entry, vars);
      const destPath = join(destDir, destName);

      if (isDirectory(srcPath)) {
        // Recursively copy directory
        copyTemplate(srcPath, destPath, vars);
      } else if (entry.endsWith('.template')) {
        // Process template file
        const content = readFileSync(srcPath, 'utf-8');
        const processed = substituteVars(content, vars);
        const finalName = destName.replace('.template', '');
        writeFileSync(join(destDir, finalName), processed);
        logger.debug(`Created from template: ${finalName}`);
      } else {
        // Copy file as-is
        copyFile(srcPath, destPath);
      }
    }

    return true;
  } catch (error) {
    logger.error('Failed to copy template:', error);
    return false;
  }
}

/**
 * Substitute template variables in a string
 *
 * Supports:
 * - {{variable}} - simple substitution
 * - {{variable|default}} - with default value
 *
 * @param content - String with template variables
 * @param vars - Variables to substitute
 * @returns Processed string
 */
export function substituteVars(content: string, vars: TemplateVars): string {
  return content.replace(
    /\{\{(\w+)(?:\|([^}]+))?\}\}/g,
    (match, name, defaultValue) => {
      const value = vars[name];
      if (value !== undefined) {
        return String(value);
      }
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      return match; // Keep original if no value or default
    }
  );
}

/**
 * List available templates
 *
 * @param templatesDir - Templates directory
 * @returns Array of template names
 */
export function listTemplates(templatesDir: string): string[] {
  if (!existsSync(templatesDir)) {
    return [];
  }

  try {
    const entries = readdirSync(templatesDir);
    return entries.filter((e) => isDirectory(join(templatesDir, e)));
  } catch {
    return [];
  }
}

/**
 * Get template info
 *
 * @param templatesDir - Templates directory
 * @param templateName - Template name
 * @returns Template info or null
 */
export function getTemplateInfo(
  templatesDir: string,
  templateName: string
): {
  name: string;
  description: string;
  files: string[];
} | null {
  const templatePath = join(templatesDir, templateName);

  if (!existsSync(templatePath) || !isDirectory(templatePath)) {
    return null;
  }

  // Try to read README or template.json for description
  let description = `Template: ${templateName}`;

  const readmePath = join(templatePath, 'README.md');
  if (existsSync(readmePath)) {
    const readme = readFileSync(readmePath, 'utf-8');
    const firstLine = readme.split('\n').find((l) => l.trim() && !l.startsWith('#'));
    if (firstLine) {
      description = firstLine.trim();
    }
  }

  const files = readdirSync(templatePath);

  return {
    name: templateName,
    description,
    files,
  };
}

/**
 * Create a project from a template
 *
 * @param templatesDir - Templates directory
 * @param templateName - Template to use
 * @param projectDir - Destination project directory
 * @param vars - Template variables
 * @returns True if successful
 */
export function createFromTemplate(
  templatesDir: string,
  templateName: string,
  projectDir: string,
  vars: TemplateVars = {}
): boolean {
  const templatePath = join(templatesDir, templateName);

  if (!existsSync(templatePath)) {
    logger.error(`Template not found: ${templateName}`);
    return false;
  }

  // Add default variables
  const fullVars: TemplateVars = {
    year: new Date().getFullYear(),
    projectName: basename(projectDir),
    ...vars,
  };

  logger.info(`Creating project from template: ${templateName}`);
  return copyTemplate(templatePath, projectDir, fullVars);
}

/**
 * Default template for new projects (embedded)
 */
export const DEFAULT_PROJECT_TEMPLATE = {
  'README.md': `# {{projectName}}

{{description|A new project created by MiloBot}}

## Getting Started

Created on {{year}}.
`,
  '.gitignore': `# Dependencies
node_modules/

# Build output
dist/
build/

# Environment
.env
.env.local

# IDE
.idea/
.vscode/
*.swp

# OS
.DS_Store
Thumbs.db
`,
  'package.json': `{
  "name": "{{projectName}}",
  "version": "0.1.0",
  "description": "{{description|A new project}}",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "test": "echo \\"No tests yet\\""
  }
}
`,
};

/**
 * Create a project using the default embedded template
 *
 * @param projectDir - Project directory
 * @param vars - Template variables
 * @returns True if successful
 */
export function createDefaultProject(
  projectDir: string,
  vars: TemplateVars = {}
): boolean {
  const fullVars: TemplateVars = {
    year: new Date().getFullYear(),
    projectName: basename(projectDir),
    ...vars,
  };

  try {
    createDirectory(projectDir);

    for (const [fileName, content] of Object.entries(DEFAULT_PROJECT_TEMPLATE)) {
      const processed = substituteVars(content, fullVars);
      const filePath = join(projectDir, fileName);
      writeFileSync(filePath, processed);
      logger.debug(`Created: ${filePath}`);
    }

    return true;
  } catch (error) {
    logger.error('Failed to create default project:', error);
    return false;
  }
}
