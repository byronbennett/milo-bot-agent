import { jest } from '@jest/globals';
import {
  handleCodexEvent,
  parseCodexLine,
  type CodexEventCallbacks,
  type CodexEventState,
} from '../../app/agent-tools/codex-event-handler.js';
import type { CodexEvent } from '../../app/agent-tools/codex-event-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCallbacks(): CodexEventCallbacks & {
  onSessionId: jest.Mock;
  onAssistantText: jest.Mock;
  onUsage: jest.Mock;
  onError: jest.Mock;
  sendIpcEvent: jest.Mock;
} {
  return {
    onSessionId: jest.fn(),
    onAssistantText: jest.fn(),
    onUsage: jest.fn(),
    onError: jest.fn(),
    sendIpcEvent: jest.fn(),
  };
}

function makeState(): CodexEventState {
  return { lastAssistantText: '', errors: [] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('codex-event-handler', () => {
  describe('handleCodexEvent', () => {
    // 1. thread.started
    it('calls onSessionId when thread.started is received', () => {
      const cb = makeCallbacks();
      const state = makeState();
      const event: CodexEvent = { type: 'thread.started', thread_id: 'thread-abc-123' };

      handleCodexEvent(event, cb, state);

      expect(cb.onSessionId).toHaveBeenCalledWith('thread-abc-123');
      expect(cb.onSessionId).toHaveBeenCalledTimes(1);
    });

    // 2. item.started commandExecution
    it('emits tool_start IPC for item.started with commandExecution', () => {
      const cb = makeCallbacks();
      const state = makeState();
      const event: CodexEvent = {
        type: 'item.started',
        item: {
          id: 'cmd-1',
          type: 'commandExecution',
          command: 'npm test',
        },
      };

      handleCodexEvent(event, cb, state);

      expect(cb.sendIpcEvent).toHaveBeenCalledWith({
        type: 'tool_start',
        toolName: 'Codex:command',
        toolCallId: 'cmd-1',
        message: 'npm test',
      });
    });

    // 3. item.started fileChange
    it('emits tool_start IPC for item.started with fileChange', () => {
      const cb = makeCallbacks();
      const state = makeState();
      const event: CodexEvent = {
        type: 'item.started',
        item: {
          id: 'fc-1',
          type: 'fileChange',
        },
      };

      handleCodexEvent(event, cb, state);

      expect(cb.sendIpcEvent).toHaveBeenCalledWith({
        type: 'tool_start',
        toolName: 'Codex:fileChange',
        toolCallId: 'fc-1',
      });
    });

    // 4. item.completed agentMessage
    it('captures text and calls onAssistantText for item.completed agentMessage', () => {
      const cb = makeCallbacks();
      const state = makeState();
      const event: CodexEvent = {
        type: 'item.completed',
        item: {
          id: 'msg-1',
          type: 'agentMessage',
          text: 'Here is my analysis of the code.',
        },
      };

      handleCodexEvent(event, cb, state);

      expect(cb.onAssistantText).toHaveBeenCalledWith('Here is my analysis of the code.');
      expect(state.lastAssistantText).toBe('Here is my analysis of the code.');
    });

    // 5. item.completed commandExecution exit 0
    it('emits tool_end with success:true for commandExecution exit 0', () => {
      const cb = makeCallbacks();
      const state = makeState();
      const event: CodexEvent = {
        type: 'item.completed',
        item: {
          id: 'cmd-2',
          type: 'commandExecution',
          command: 'echo hello',
          status: 'completed',
          exitCode: 0,
        },
      };

      handleCodexEvent(event, cb, state);

      expect(cb.sendIpcEvent).toHaveBeenCalledWith({
        type: 'tool_end',
        toolName: 'Codex:command',
        toolCallId: 'cmd-2',
        success: true,
        summary: 'echo hello → exit 0',
      });
    });

    // 6. item.completed commandExecution exit 1
    it('emits tool_end with success:false for commandExecution exit 1', () => {
      const cb = makeCallbacks();
      const state = makeState();
      const event: CodexEvent = {
        type: 'item.completed',
        item: {
          id: 'cmd-3',
          type: 'commandExecution',
          command: 'false',
          status: 'failed',
          exitCode: 1,
        },
      };

      handleCodexEvent(event, cb, state);

      expect(cb.sendIpcEvent).toHaveBeenCalledWith({
        type: 'tool_end',
        toolName: 'Codex:command',
        toolCallId: 'cmd-3',
        success: false,
        summary: 'false → exit 1',
      });
    });

    // 7. item.completed fileChange
    it('emits tool_end with file paths for completed fileChange', () => {
      const cb = makeCallbacks();
      const state = makeState();
      const event: CodexEvent = {
        type: 'item.completed',
        item: {
          id: 'fc-2',
          type: 'fileChange',
          changes: [
            { path: 'src/index.ts', kind: 'modified' },
            { path: 'README.md', kind: 'modified' },
          ],
        },
      };

      handleCodexEvent(event, cb, state);

      expect(cb.sendIpcEvent).toHaveBeenCalledWith({
        type: 'tool_end',
        toolName: 'Codex:fileChange',
        toolCallId: 'fc-2',
        success: true,
        summary: 'src/index.ts, README.md',
      });
    });

    // 8. item.completed declined operation
    it('emits progress warning AND tool_end failure for declined operation', () => {
      const cb = makeCallbacks();
      const state = makeState();
      const event: CodexEvent = {
        type: 'item.completed',
        item: {
          id: 'cmd-4',
          type: 'commandExecution',
          command: 'rm -rf /',
          status: 'declined',
        },
      };

      handleCodexEvent(event, cb, state);

      // Should emit two IPC events
      expect(cb.sendIpcEvent).toHaveBeenCalledTimes(2);

      // First: progress warning
      expect(cb.sendIpcEvent).toHaveBeenNthCalledWith(1, {
        type: 'progress',
        message: '[Codex declined] rm -rf /',
      });

      // Second: tool_end with failure
      expect(cb.sendIpcEvent).toHaveBeenNthCalledWith(2, {
        type: 'tool_end',
        toolName: 'Codex:command',
        toolCallId: 'cmd-4',
        success: false,
        summary: 'Declined: rm -rf /',
      });
    });

    // 9. agentMessage delta
    it('forwards agentMessage delta as stream_text IPC', () => {
      const cb = makeCallbacks();
      const state = makeState();
      const event: CodexEvent = {
        type: 'item.agentMessage.delta',
        delta: 'Hello, ',
      };

      handleCodexEvent(event, cb, state);

      expect(cb.sendIpcEvent).toHaveBeenCalledWith({
        type: 'stream_text',
        delta: 'Hello, ',
      });
    });

    // 10. commandExecution outputDelta
    it('forwards commandExecution outputDelta as stream_text IPC', () => {
      const cb = makeCallbacks();
      const state = makeState();
      const event: CodexEvent = {
        type: 'item.commandExecution.outputDelta',
        delta: 'PASS tests/foo.test.ts\n',
      };

      handleCodexEvent(event, cb, state);

      expect(cb.sendIpcEvent).toHaveBeenCalledWith({
        type: 'stream_text',
        delta: 'PASS tests/foo.test.ts\n',
      });
    });

    // 11. turn.completed with usage
    it('calls onUsage when turn.completed has usage data', () => {
      const cb = makeCallbacks();
      const state = makeState();
      const event: CodexEvent = {
        type: 'turn.completed',
        usage: { input_tokens: 1500, output_tokens: 300 },
      };

      handleCodexEvent(event, cb, state);

      expect(cb.onUsage).toHaveBeenCalledWith({ input_tokens: 1500, output_tokens: 300 });
      expect(cb.onUsage).toHaveBeenCalledTimes(1);
    });

    // 11b. turn.completed without usage
    it('does not call onUsage when turn.completed has no usage', () => {
      const cb = makeCallbacks();
      const state = makeState();
      const event: CodexEvent = { type: 'turn.completed' };

      handleCodexEvent(event, cb, state);

      expect(cb.onUsage).not.toHaveBeenCalled();
    });

    // 12. turn.failed
    it('accumulates error with codexErrorInfo from turn.failed', () => {
      const cb = makeCallbacks();
      const state = makeState();
      const event: CodexEvent = {
        type: 'turn.failed',
        error: {
          message: 'Rate limit exceeded',
          codexErrorInfo: 'retry after 30s',
        },
      };

      handleCodexEvent(event, cb, state);

      expect(state.errors).toHaveLength(1);
      expect(state.errors[0]).toBe('Rate limit exceeded — retry after 30s');
      expect(cb.onError).toHaveBeenCalledWith('Rate limit exceeded — retry after 30s');
    });

    // 12b. turn.failed with additionalDetails
    it('includes additionalDetails in turn.failed error message', () => {
      const cb = makeCallbacks();
      const state = makeState();
      const event: CodexEvent = {
        type: 'turn.failed',
        error: {
          message: 'API error',
          codexErrorInfo: 'status 500',
          additionalDetails: 'Internal server error',
        },
      };

      handleCodexEvent(event, cb, state);

      expect(state.errors[0]).toBe('API error — status 500 — Internal server error');
      expect(cb.onError).toHaveBeenCalledWith('API error — status 500 — Internal server error');
    });

    // 12c. generic error event
    it('accumulates error from top-level error event', () => {
      const cb = makeCallbacks();
      const state = makeState();
      const event: CodexEvent = {
        type: 'error',
        message: 'Connection reset',
      };

      handleCodexEvent(event, cb, state);

      expect(state.errors).toHaveLength(1);
      expect(state.errors[0]).toBe('Connection reset');
      expect(cb.onError).toHaveBeenCalledWith('Connection reset');
    });

    // 13. unknown events don't throw
    it('silently ignores unknown event types', () => {
      const cb = makeCallbacks();
      const state = makeState();
      const event = { type: 'some.future.event', data: 123 } as unknown as CodexEvent;

      expect(() => handleCodexEvent(event, cb, state)).not.toThrow();
      expect(cb.sendIpcEvent).not.toHaveBeenCalled();
      expect(cb.onSessionId).not.toHaveBeenCalled();
      expect(cb.onAssistantText).not.toHaveBeenCalled();
      expect(cb.onUsage).not.toHaveBeenCalled();
      expect(cb.onError).not.toHaveBeenCalled();
    });

    // Extra: item.started with unrecognised item type is ignored
    it('ignores item.started with unrecognised item type', () => {
      const cb = makeCallbacks();
      const state = makeState();
      const event: CodexEvent = {
        type: 'item.started',
        item: { id: 'r-1', type: 'reasoning', summary: 'thinking...' },
      };

      handleCodexEvent(event, cb, state);

      expect(cb.sendIpcEvent).not.toHaveBeenCalled();
    });

    // Extra: agentMessage with no text defaults to empty string
    it('defaults to empty string for agentMessage with no text', () => {
      const cb = makeCallbacks();
      const state = makeState();
      const event: CodexEvent = {
        type: 'item.completed',
        item: { id: 'msg-2', type: 'agentMessage' },
      };

      handleCodexEvent(event, cb, state);

      expect(state.lastAssistantText).toBe('');
      expect(cb.onAssistantText).toHaveBeenCalledWith('');
    });

    // Extra: declined fileChange
    it('handles declined fileChange item', () => {
      const cb = makeCallbacks();
      const state = makeState();
      const event: CodexEvent = {
        type: 'item.completed',
        item: {
          id: 'fc-3',
          type: 'fileChange',
          status: 'declined',
        },
      };

      handleCodexEvent(event, cb, state);

      expect(cb.sendIpcEvent).toHaveBeenCalledTimes(2);
      expect(cb.sendIpcEvent).toHaveBeenNthCalledWith(1, {
        type: 'progress',
        message: '[Codex declined] fileChange',
      });
      expect(cb.sendIpcEvent).toHaveBeenNthCalledWith(2, {
        type: 'tool_end',
        toolName: 'Codex:fileChange',
        toolCallId: 'fc-3',
        success: false,
        summary: 'Declined: fileChange',
      });
    });
  });

  // -----------------------------------------------------------------------
  // parseCodexLine
  // -----------------------------------------------------------------------

  describe('parseCodexLine', () => {
    it('parses valid JSON into a CodexEvent', () => {
      const line = '{"type":"thread.started","thread_id":"t-1"}';
      const result = parseCodexLine(line);
      expect(result).toEqual({ type: 'thread.started', thread_id: 't-1' });
    });

    it('returns null for empty lines', () => {
      expect(parseCodexLine('')).toBeNull();
      expect(parseCodexLine('   ')).toBeNull();
      expect(parseCodexLine('\n')).toBeNull();
      expect(parseCodexLine('\t  \n')).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      expect(parseCodexLine('not json')).toBeNull();
      expect(parseCodexLine('{broken')).toBeNull();
      expect(parseCodexLine('{{}')).toBeNull();
    });

    it('handles JSON with leading/trailing whitespace', () => {
      const result = parseCodexLine('  {"type":"error","message":"oops"}  ');
      expect(result).toEqual({ type: 'error', message: 'oops' });
    });
  });
});
