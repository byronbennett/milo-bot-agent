/**
 * Event handler for OpenAI Codex CLI JSONL events.
 *
 * Codex CLI (`codex exec --json`) emits newline-delimited JSON events
 * describing thread lifecycle, item execution, streaming deltas, and errors.
 * This module parses each line and forwards structured events to the
 * orchestrator via IPC callbacks — mirroring the pattern used by
 * claude-event-handler.ts for Claude Code.
 */

import type {
  CodexEvent,
  CodexThreadStarted,
  CodexTurnCompleted,
  CodexTurnFailed,
  CodexError,
  CodexItemStarted,
  CodexItemCompleted,
  CodexCommandExecutionItem,
  CodexFileChangeItem,
  CodexAgentMessageItem,
  CodexAgentMessageDelta,
  CodexCommandOutputDelta,
} from './codex-event-types.js';

// ---------------------------------------------------------------------------
// Callback & state interfaces
// ---------------------------------------------------------------------------

export interface CodexEventCallbacks {
  /** Called when the Codex thread ID is received. */
  onSessionId: (id: string) => void;
  /** Called with the latest assistant (agent) text. */
  onAssistantText: (text: string) => void;
  /** Called with token usage after a turn completes. */
  onUsage: (usage: { input_tokens?: number; output_tokens?: number }) => void;
  /** Called when an error is encountered. */
  onError: (message: string) => void;
  /** Forwards a structured IPC event to the orchestrator. */
  sendIpcEvent: (event: {
    type: 'tool_start' | 'tool_end' | 'stream_text' | 'progress';
    toolName?: string;
    toolCallId?: string;
    delta?: string;
    message?: string;
    success?: boolean;
    summary?: string;
  }) => void;
}

export interface CodexEventState {
  /** The most recent assistant text from an agentMessage item. */
  lastAssistantText: string;
  /** Accumulated error messages. */
  errors: string[];
}

// ---------------------------------------------------------------------------
// JSONL line parser
// ---------------------------------------------------------------------------

/**
 * Parse a single JSONL line into a CodexEvent.
 * Returns `null` for empty lines or unparseable JSON.
 */
export function parseCodexLine(line: string): CodexEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as CodexEvent;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Event handler
// ---------------------------------------------------------------------------

/**
 * Process a single CodexEvent and dispatch to the appropriate callbacks.
 * Unknown event types are silently ignored.
 */
export function handleCodexEvent(
  event: CodexEvent,
  callbacks: CodexEventCallbacks,
  state: CodexEventState,
): void {
  switch (event.type) {
    // -- Thread lifecycle --------------------------------------------------
    case 'thread.started': {
      const e = event as CodexThreadStarted;
      callbacks.onSessionId(e.thread_id);
      break;
    }

    case 'turn.completed': {
      const e = event as CodexTurnCompleted;
      if (e.usage) {
        callbacks.onUsage(e.usage);
      }
      break;
    }

    case 'turn.failed': {
      const e = event as CodexTurnFailed;
      const parts: string[] = [e.error.message];
      if (e.error.codexErrorInfo) parts.push(e.error.codexErrorInfo);
      if (e.error.additionalDetails) parts.push(e.error.additionalDetails);
      const msg = parts.join(' — ');
      state.errors.push(msg);
      callbacks.onError(msg);
      break;
    }

    case 'error': {
      const e = event as CodexError;
      state.errors.push(e.message);
      callbacks.onError(e.message);
      break;
    }

    // -- Item started ------------------------------------------------------
    case 'item.started': {
      const item = (event as CodexItemStarted).item;
      if (item.type === 'commandExecution') {
        const cmd = item as CodexCommandExecutionItem;
        callbacks.sendIpcEvent({
          type: 'tool_start',
          toolName: 'Codex:command',
          toolCallId: cmd.id,
          message: cmd.command,
        });
      } else if (item.type === 'fileChange') {
        callbacks.sendIpcEvent({
          type: 'tool_start',
          toolName: 'Codex:fileChange',
          toolCallId: item.id,
        });
      }
      break;
    }

    // -- Item completed ----------------------------------------------------
    case 'item.completed': {
      const item = (event as CodexItemCompleted).item;

      // Check for declined status first (applies to any item type)
      if ('status' in item && item.status === 'declined') {
        const label =
          item.type === 'commandExecution'
            ? (item as CodexCommandExecutionItem).command ?? item.type
            : item.type;
        callbacks.sendIpcEvent({
          type: 'progress',
          message: `[Codex declined] ${label}`,
        });
        callbacks.sendIpcEvent({
          type: 'tool_end',
          toolName: item.type === 'commandExecution' ? 'Codex:command' : `Codex:${item.type}`,
          toolCallId: item.id,
          success: false,
          summary: `Declined: ${label}`,
        });
        break;
      }

      switch (item.type) {
        case 'agentMessage': {
          const agentItem = item as CodexAgentMessageItem;
          const text = agentItem.text ?? '';
          state.lastAssistantText = text;
          callbacks.onAssistantText(text);
          break;
        }

        case 'commandExecution': {
          const cmd = item as CodexCommandExecutionItem;
          const exitCode = cmd.exitCode ?? -1;
          const success =
            cmd.status === 'completed' && exitCode === 0;
          callbacks.sendIpcEvent({
            type: 'tool_end',
            toolName: 'Codex:command',
            toolCallId: cmd.id,
            success,
            summary: `${cmd.command ?? 'command'} → exit ${exitCode}`,
          });
          break;
        }

        case 'fileChange': {
          const fc = item as CodexFileChangeItem;
          const paths = fc.changes?.map((c) => c.path).join(', ') ?? 'unknown';
          callbacks.sendIpcEvent({
            type: 'tool_end',
            toolName: 'Codex:fileChange',
            toolCallId: fc.id,
            success: true,
            summary: paths,
          });
          break;
        }

        default:
          // Other completed item types (reasoning, plan, etc.) — ignore
          break;
      }
      break;
    }

    // -- Streaming deltas --------------------------------------------------
    case 'item.agentMessage.delta': {
      const e = event as CodexAgentMessageDelta;
      callbacks.sendIpcEvent({
        type: 'stream_text',
        delta: e.delta,
      });
      break;
    }

    case 'item.commandExecution.outputDelta': {
      const e = event as CodexCommandOutputDelta;
      callbacks.sendIpcEvent({
        type: 'stream_text',
        delta: e.delta,
      });
      break;
    }

    // -- All other events: silently ignore ---------------------------------
    default:
      break;
  }
}
