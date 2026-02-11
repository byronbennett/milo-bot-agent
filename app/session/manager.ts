import { existsSync, readFileSync, writeFileSync, readdirSync, renameSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface SessionManagerOptions {
  baseDir: string;
  sessionsDir: string;
}

export interface SessionInfo {
  name: string;
  status: string;
  createdAt?: Date;
  retryCount: number;
}

/**
 * Manages local session files
 */
export class SessionManager {
  private baseDir: string;
  private sessionsDir: string;
  private archiveDir: string;

  constructor(options: SessionManagerOptions) {
    this.baseDir = options.baseDir;
    this.sessionsDir = join(options.baseDir, options.sessionsDir);
    this.archiveDir = join(this.sessionsDir, 'archive');

    // Ensure directories exist
    mkdirSync(this.sessionsDir, { recursive: true });
    mkdirSync(this.archiveDir, { recursive: true });
  }

  /**
   * List active sessions (non-archived)
   */
  async listActiveSessions(): Promise<SessionInfo[]> {
    const files = readdirSync(this.sessionsDir).filter(
      (f) => f.endsWith('.md') && f !== 'archive'
    );

    return files.map((file) => {
      const name = file.replace('.md', '');
      const content = readFileSync(join(this.sessionsDir, file), 'utf-8');
      return this.parseSessionInfo(name, content);
    });
  }

  /**
   * List archived sessions
   */
  async listArchivedSessions(): Promise<SessionInfo[]> {
    if (!existsSync(this.archiveDir)) {
      return [];
    }

    const files = readdirSync(this.archiveDir).filter((f) => f.endsWith('.md'));

    return files.map((file) => {
      const name = file.replace('.md', '');
      const content = readFileSync(join(this.archiveDir, file), 'utf-8');
      return this.parseSessionInfo(name, content);
    });
  }

  /**
   * Get session by name
   */
  async getSession(name: string): Promise<SessionInfo | null> {
    const filePath = join(this.sessionsDir, `${name}.md`);

    if (!existsSync(filePath)) {
      // Check archive
      const archivePath = join(this.archiveDir, `${name}.md`);
      if (!existsSync(archivePath)) {
        return null;
      }
      const content = readFileSync(archivePath, 'utf-8');
      return this.parseSessionInfo(name, content);
    }

    const content = readFileSync(filePath, 'utf-8');
    return this.parseSessionInfo(name, content);
  }

  /**
   * Create a new session
   */
  async createSession(name: string, prompt: string): Promise<SessionInfo> {
    const filePath = join(this.sessionsDir, `${name}.md`);

    if (existsSync(filePath)) {
      throw new Error(`Session '${name}' already exists`);
    }

    const now = new Date().toISOString();
    const content = `# INFO
- Session Name: ${name}
- Created: ${now}
- Status: IN_PROGRESS
- Retry Count: 0
- Claude Code Session ID:

# TASKS
- [ ] Open Claude Code session
- [ ] Send enhanced prompt to Claude Code
- [ ] Monitor Claude Code until completion
- [ ] Report results to user
- [ ] Clean up session

# ENHANCED PROMPT
${prompt}

# MONITORING

## Auto-answer rules for session:

## Questions/answers from Claude Code:

## Messages to/from user:
- [${now}] [TO_USER] Session started: ${name}

# ERROR LOG
`;

    writeFileSync(filePath, content);

    return {
      name,
      status: 'IN_PROGRESS',
      createdAt: new Date(),
      retryCount: 0,
    };
  }

  /**
   * Update session status
   */
  async updateSessionStatus(name: string, status: string): Promise<void> {
    const filePath = join(this.sessionsDir, `${name}.md`);

    if (!existsSync(filePath)) {
      throw new Error(`Session '${name}' not found`);
    }

    let content = readFileSync(filePath, 'utf-8');
    content = content.replace(/- Status: \w+/, `- Status: ${status}`);
    writeFileSync(filePath, content);
  }

  /**
   * Archive a session
   */
  async archiveSession(name: string): Promise<void> {
    const srcPath = join(this.sessionsDir, `${name}.md`);
    const destPath = join(this.archiveDir, `${name}.md`);

    if (!existsSync(srcPath)) {
      throw new Error(`Session '${name}' not found`);
    }

    renameSync(srcPath, destPath);
  }

  /**
   * Parse session info from file content
   */
  private parseSessionInfo(name: string, content: string): SessionInfo {
    const statusMatch = content.match(/- Status: (\w+)/);
    const createdMatch = content.match(/- Created: (.+)/);
    const retryMatch = content.match(/- Retry Count: (\d+)/);

    return {
      name,
      status: statusMatch ? statusMatch[1] : 'unknown',
      createdAt: createdMatch ? new Date(createdMatch[1]) : undefined,
      retryCount: retryMatch ? parseInt(retryMatch[1], 10) : 0,
    };
  }
}
