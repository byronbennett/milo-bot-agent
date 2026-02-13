/**
 * JSON Lines IPC helpers for orchestrator ↔ worker communication.
 *
 * Protocol: one JSON object per line, delimited by \n.
 * Used over stdin/stdout of child processes.
 */

import type { Readable, Writable } from 'stream';
import type { IPCMessage } from './ipc-types.js';

/**
 * Write a single IPC message to a writable stream.
 */
export function sendIPC(stream: Writable, message: IPCMessage): void {
  stream.write(JSON.stringify(message) + '\n');
}

/**
 * Create an async iterator that yields parsed IPC messages from a readable stream.
 */
export async function* readIPC(stream: Readable): AsyncGenerator<IPCMessage> {
  let buffer = '';

  for await (const chunk of stream) {
    buffer += chunk.toString();

    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);

      if (line.length === 0) continue;

      try {
        yield JSON.parse(line) as IPCMessage;
      } catch {
        // Skip malformed lines — log to stderr so it doesn't pollute IPC stdout
        process.stderr.write(`[ipc] malformed JSON line: ${line.slice(0, 200)}\n`);
      }
    }
  }
}
