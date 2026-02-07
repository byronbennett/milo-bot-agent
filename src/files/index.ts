/**
 * Files Module
 *
 * Exports for file, git, and template operations.
 */

// File manager
export {
  createDirectory,
  createFile,
  readFile,
  writeFile,
  deleteFile,
  exists,
  isDirectory,
  listFiles,
  copyFile,
  copyDirectory,
  getFileInfo,
} from './manager';

// Git operations
export {
  initRepo,
  isGitRepo,
  stageFiles,
  commit,
  push,
  getCurrentBranch,
  getStatus,
  getLatestCommit,
  configureUser,
  addRemote,
  createBranch,
  checkout,
} from './git';

// Template handling
export {
  copyTemplate,
  substituteVars,
  listTemplates,
  getTemplateInfo,
  createFromTemplate,
  createDefaultProject,
  DEFAULT_PROJECT_TEMPLATE,
  type TemplateVars,
} from './templates';
