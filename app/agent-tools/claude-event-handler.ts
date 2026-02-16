/**
 * Shared event handler for Claude Code NDJSON messages.
 *
 * Both the SDK-based tool (cli-agent-tools.ts) and the OAuth CLI tool
 * (claude-code-oauth-tool.ts) emit the same message types:
 *   system, stream_event, assistant, result
 *
 * This module provides a single handleMessage() function that processes
 * those messages and calls back into the tool's state management.
 */

import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ToolContext } from './index.js';

export interface HandleMessageCallbacks {
  onSessionId: (id: string) => void;
  onResultMessage: (msg: SDKResultMessage) => void;
  onAssistantText: (text: string) => void;
}

/**
 * Extract text content from an assistant message's content blocks.
 */
export function extractTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n');
}

/**
 * Process a single SDKMessage from the Claude Code async generator.
 * Forwards events to the orchestrator via ctx.sendIpcEvent.
 */
export function handleMessage(
  message: SDKMessage,
  ctx: ToolContext,
  callbacks: HandleMessageCallbacks,
): void {
  switch (message.type) {
    case 'system':
      if ('subtype' in message && message.subtype === 'init') {
        callbacks.onSessionId(message.session_id);
      }
      break;

    case 'stream_event':
      // SDKPartialAssistantMessage — forward text deltas
      if (message.event?.type === 'content_block_delta') {
        const delta = (message.event as any).delta;
        if (delta?.type === 'text_delta' && delta.text) {
          ctx.sendIpcEvent?.({
            type: 'stream_text',
            delta: delta.text,
          });
        }
      }
      break;

    case 'assistant': {
      // Forward tool_use blocks as tool_start events
      const content = message.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if ((block as any).type === 'tool_use') {
            ctx.sendIpcEvent?.({
              type: 'tool_start',
              toolName: `CC:${(block as any).name}`,
              toolCallId: (block as any).id,
            });
          }
        }
        // Capture latest assistant text
        const text = extractTextFromContent(content);
        if (text) {
          callbacks.onAssistantText(text);
        }
      }
      break;
    }

    case 'result':
      callbacks.onResultMessage(message as SDKResultMessage);
      break;
  }
}
