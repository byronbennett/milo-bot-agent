/**
 * Built-in Tools
 *
 * Automatically registers all built-in tools when imported.
 */

// Import each tool to trigger registration
import './create-project';
import './init-git-repo';
import './list-files';

export { meta as createProjectMeta } from './create-project';
export { meta as initGitRepoMeta } from './init-git-repo';
export { meta as listFilesMeta } from './list-files';
