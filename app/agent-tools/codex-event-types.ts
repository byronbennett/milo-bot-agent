/**
 * TypeScript type definitions for OpenAI Codex CLI JSONL events.
 *
 * Codex CLI outputs newline-delimited JSON (JSONL) events when run in
 * non-interactive mode. These types model every known event shape so the
 * event handler can process them with full type safety.
 *
 * @see https://developers.openai.com/codex/noninteractive/
 */

// ---------------------------------------------------------------------------
// Top-level lifecycle events
// ---------------------------------------------------------------------------

export interface CodexThreadStarted {
  type: 'thread.started';
  thread_id: string;
}

export interface CodexTurnStarted {
  type: 'turn.started';
}

export interface CodexTurnCompleted {
  type: 'turn.completed';
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

export interface CodexTurnFailed {
  type: 'turn.failed';
  error: {
    message: string;
    codexErrorInfo?: string;
    additionalDetails?: string;
  };
}

export interface CodexError {
  type: 'error';
  message: string;
}

// ---------------------------------------------------------------------------
// Item types — the payloads carried by item.started / item.completed events
// ---------------------------------------------------------------------------

export interface CodexAgentMessageItem {
  id: string;
  type: 'agentMessage';
  text?: string;
}

export interface CodexCommandExecutionItem {
  id: string;
  type: 'commandExecution';
  command?: string;
  cwd?: string;
  status?: 'inProgress' | 'completed' | 'failed' | 'declined';
  exitCode?: number;
  durationMs?: number;
  aggregatedOutput?: string;
}

export interface CodexFileChangeItem {
  id: string;
  type: 'fileChange';
  changes?: Array<{
    path: string;
    kind: string;
    diff?: string;
  }>;
  status?: string;
}

export interface CodexReasoningItem {
  id: string;
  type: 'reasoning';
  summary?: string;
  content?: string;
}

export interface CodexPlanItem {
  id: string;
  type: 'plan';
  text?: string;
}

/** Catch-all for unrecognised item types emitted by future Codex versions. */
export interface CodexGenericItem {
  id: string;
  type: string;
  [key: string]: unknown;
}

/** Union of every known item type plus the generic catch-all. */
export type CodexItem =
  | CodexAgentMessageItem
  | CodexCommandExecutionItem
  | CodexFileChangeItem
  | CodexReasoningItem
  | CodexPlanItem
  | CodexGenericItem;

// ---------------------------------------------------------------------------
// Item wrapper events
// ---------------------------------------------------------------------------

export interface CodexItemStarted {
  type: 'item.started';
  item: CodexItem;
}

export interface CodexItemCompleted {
  type: 'item.completed';
  item: CodexItem;
}

// ---------------------------------------------------------------------------
// Streaming delta events
// ---------------------------------------------------------------------------

export interface CodexAgentMessageDelta {
  type: 'item.agentMessage.delta';
  delta: string;
}

export interface CodexCommandOutputDelta {
  type: 'item.commandExecution.outputDelta';
  delta: string;
}

export interface CodexFileChangeDelta {
  type: 'item.fileChange.outputDelta';
  delta: string;
}

export interface CodexReasoningDelta {
  type: 'item.reasoning.summaryTextDelta' | 'item.reasoning.textDelta';
  delta: string;
}

export interface CodexPlanDelta {
  type: 'item.plan.delta';
  delta: string;
}

// ---------------------------------------------------------------------------
// Top-level union — every event the JSONL stream can produce
// ---------------------------------------------------------------------------

export type CodexEvent =
  | CodexThreadStarted
  | CodexTurnStarted
  | CodexTurnCompleted
  | CodexTurnFailed
  | CodexError
  | CodexItemStarted
  | CodexItemCompleted
  | CodexAgentMessageDelta
  | CodexCommandOutputDelta
  | CodexFileChangeDelta
  | CodexReasoningDelta
  | CodexPlanDelta
  | { type: string; [key: string]: unknown };
