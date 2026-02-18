import { sendIPC, readIPC } from '../../app/orchestrator/ipc.js';
import { PassThrough } from 'stream';
import type { IPCMessage } from '../../app/orchestrator/ipc-types.js';

describe('IPC helpers', () => {
  test('sendIPC writes JSON line to stream', () => {
    const stream = new PassThrough();
    const chunks: string[] = [];
    stream.on('data', (chunk) => chunks.push(chunk.toString()));

    const msg: IPCMessage = {
      type: 'WORKER_READY',
      sessionId: 'test-session',
      pid: 1234,
    };

    sendIPC(stream, msg);
    stream.end();

    const written = chunks.join('');
    expect(written).toBe(JSON.stringify(msg) + '\n');
  });

  test('readIPC yields parsed messages from stream', async () => {
    const stream = new PassThrough();

    const msg1: IPCMessage = { type: 'WORKER_READY', sessionId: 's1', pid: 1 };
    const msg2: IPCMessage = { type: 'WORKER_TASK_STARTED', taskId: 't1', sessionId: 's1' };

    stream.write(JSON.stringify(msg1) + '\n');
    stream.write(JSON.stringify(msg2) + '\n');
    stream.end();

    const messages: IPCMessage[] = [];
    for await (const m of readIPC(stream)) {
      messages.push(m);
    }

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual(msg1);
    expect(messages[1]).toEqual(msg2);
  });

  test('readIPC skips malformed lines', async () => {
    const stream = new PassThrough();

    stream.write('not json\n');
    stream.write(JSON.stringify({ type: 'WORKER_READY', sessionId: 's1', pid: 1 }) + '\n');
    stream.end();

    const messages: IPCMessage[] = [];
    for await (const m of readIPC(stream)) {
      messages.push(m);
    }

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('WORKER_READY');
  });

  test('WORKER_STREAM_TEXT can be sent and received', async () => {
    const stream = new PassThrough();

    const msg: IPCMessage = {
      type: 'WORKER_STREAM_TEXT',
      sessionId: 's1',
      taskId: 't1',
      delta: 'Hello, world!',
    };

    sendIPC(stream, msg);
    stream.end();

    const messages: IPCMessage[] = [];
    for await (const m of readIPC(stream)) {
      messages.push(m);
    }

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(msg);
    expect(messages[0].type).toBe('WORKER_STREAM_TEXT');
  });

  test('WORKER_STEER can be sent and received', async () => {
    const stream = new PassThrough();

    const msg: IPCMessage = {
      type: 'WORKER_STEER',
      prompt: 'Focus on the login module instead',
    };

    sendIPC(stream, msg);
    stream.end();

    const messages: IPCMessage[] = [];
    for await (const m of readIPC(stream)) {
      messages.push(m);
    }

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(msg);
    expect(messages[0].type).toBe('WORKER_STEER');
  });

  test('WORKER_TASK with persona fields can be sent and received', async () => {
    const stream = new PassThrough();

    const msg: IPCMessage = {
      type: 'WORKER_TASK',
      taskId: 't1',
      userEventId: 'evt-1',
      prompt: 'Fix the login bug',
      personaId: 'persona-abc',
      personaVersionId: 'v3',
      model: 'claude-sonnet-4-6-20250514',
    };

    sendIPC(stream, msg);
    stream.end();

    const messages: IPCMessage[] = [];
    for await (const m of readIPC(stream)) {
      messages.push(m);
    }

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(msg);
    const task = messages[0] as import('../../app/orchestrator/ipc-types.js').WorkerTaskMessage;
    expect(task.personaId).toBe('persona-abc');
    expect(task.personaVersionId).toBe('v3');
    expect(task.model).toBe('claude-sonnet-4-6-20250514');
  });

  test('readIPC handles chunked data across line boundaries', async () => {
    const stream = new PassThrough();
    const msg: IPCMessage = { type: 'WORKER_READY', sessionId: 's1', pid: 1 };
    const json = JSON.stringify(msg);

    // Split the JSON across two chunks
    const mid = Math.floor(json.length / 2);
    stream.write(json.slice(0, mid));
    stream.write(json.slice(mid) + '\n');
    stream.end();

    const messages: IPCMessage[] = [];
    for await (const m of readIPC(stream)) {
      messages.push(m);
    }

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(msg);
  });
});
