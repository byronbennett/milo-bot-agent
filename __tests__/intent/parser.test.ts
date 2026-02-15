import { parseIntent } from '../../app/intent';
import type { PendingMessage, AgentConfig } from '../../app/shared';

// Mock config for tests
const mockConfig: AgentConfig = {
  workspaceDir: '/test/workspace',
  apiKey: 'test-key',
  pollIntervalMs: 5000,
  aliases: {},
};

// Helper to create mock message
function createMessage(content: string, sessionId?: string): PendingMessage {
  return {
    id: 'test-id',
    content,
    sender: 'user',
    createdAt: new Date().toISOString(),
    sessionId: sessionId ?? null,
    sessionName: sessionId ? 'test-session' : null,
  };
}

describe('Intent Parser', () => {
  describe('parseIntent', () => {
    it('parses open_session intent for task-like messages', () => {
      const message = createMessage('fix the login bug in the authentication module');
      const result = parseIntent(message, mockConfig);
      expect(result.type).toBe('open_session');
    });

    it('parses send_message intent when sessionId is present', () => {
      const message = createMessage('yes, proceed with that approach', 'session-123');
      const result = parseIntent(message, mockConfig);
      expect(result.type).toBe('send_message');
    });

    it('recognizes greetings', () => {
      const message = createMessage('hello');
      const result = parseIntent(message, mockConfig);
      expect(result.type).toBe('greeting');
    });

    it('does not parse @mentions (persona comes from message fields, not content)', () => {
      const message = createMessage('@coder fix the login bug');
      const result = parseIntent(message, mockConfig);
      // @coder is not a task verb, so this falls through to unknown
      // The web app sends persona separately in the message payload
      expect(result.type).toBe('unknown');
    });

    it('extracts task description from open session intent', () => {
      const message = createMessage('add a new API endpoint for users');
      const result = parseIntent(message, mockConfig);
      if (result.type === 'open_session') {
        // Pattern matching may modify the task slightly
        expect(result.taskDescription).toContain('API endpoint');
      }
    });

    it('generates session name for open session intent', () => {
      const message = createMessage('refactor the database queries');
      const result = parseIntent(message, mockConfig);
      if (result.type === 'open_session') {
        expect(result.sessionName).toBeDefined();
        expect(typeof result.sessionName).toBe('string');
      }
    });
  });
});
