import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { Readable } from 'stream';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockProcess(jsonlLines: string[], exitCode = 0) {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: new EventEmitter(),
    killed: false,
    kill: jest.fn(function (this: any) {
      this.killed = true;
    }),
    pid: 12345,
  });

  setImmediate(() => {
    for (const line of jsonlLines) {
      stdout.push(line + '\n');
    }
    stdout.push(null);
    stderr.push(null);
    proc.emit('close', exitCode);
  });

  return proc;
}

function makeCtx() {
  return {
    projectPath: '/tmp/milo-workspace/PROJECTS/my-project',
    workspaceDir: '/tmp/milo-workspace',
    sessionId: 'test-session',
    sessionName: 'test',
    currentTaskId: () => 'task-1',
    sendNotification: jest.fn(),
    askUser: jest.fn(),
    sendIpcEvent: jest.fn(),
  };
}

// ---------------------------------------------------------------------------
// ESM mocks — MUST come before await import() of the module under test
// ---------------------------------------------------------------------------

const mockSpawn = jest.fn<any>();

jest.unstable_mockModule('child_process', () => ({
  spawn: mockSpawn,
}));

const mockFindCodexBinary = jest.fn<any>();

jest.unstable_mockModule('../../app/agent-tools/codex-cli-runtime.js', () => ({
  findCodexBinary: mockFindCodexBinary,
  buildCodexArgs: jest.fn(
    (opts: { prompt: string; cwd: string; sessionId?: string; model?: string }) => {
      const args = ['-a', 'never', '-s', 'workspace-write', '-C', opts.cwd];
      if (opts.model) args.push('-m', opts.model);
      args.push('exec', '--json', '--skip-git-repo-check');
      if (opts.sessionId) {
        args.push('resume', opts.sessionId);
      }
      args.push(opts.prompt);
      return args;
    },
  ),
  escalatingKill: jest.fn(),
  CODEX_TIMEOUT_MS: 30 * 60 * 1000,
}));

// Also mock project-guard to avoid path assertions in tests
jest.unstable_mockModule('../../app/agent-tools/project-guard.js', () => ({
  assertProjectConfirmed: jest.fn(),
}));

// Now dynamically import the module under test
const { createCliAgentTools } = await import('../../app/agent-tools/cli-agent-tools.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('codex_cli tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindCodexBinary.mockResolvedValue('/usr/local/bin/codex');
  });

  it('returns result content with assistant text and session_id', async () => {
    const jsonlLines = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-abc-123' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'msg-1', type: 'agentMessage', text: 'I have fixed the bug.' },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 1000, output_tokens: 200 },
      }),
    ];

    const proc = createMockProcess(jsonlLines, 0);
    mockSpawn.mockReturnValue(proc);

    const ctx = makeCtx();
    const tools = createCliAgentTools(ctx as any);
    const codexTool = tools.find((t) => t.name === 'codex_cli')!;
    expect(codexTool).toBeDefined();

    const result = await codexTool.execute(
      'tc-1',
      { prompt: 'Fix the bug in index.ts' },
      new AbortController().signal,
      jest.fn(),
    );

    // Result content should contain assistant text
    expect(result.content[0].type).toBe('text');
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toContain('I have fixed the bug.');

    // Result content should contain session_id continuation hint
    expect(text).toContain('session_id');
    expect(text).toContain('thread-abc-123');

    // details.session_id is set
    expect(result.details?.session_id).toBe('thread-abc-123');

    // details.usage matches
    expect(result.details?.usage).toEqual({ input_tokens: 1000, output_tokens: 200 });
  });

  it('throws on non-zero exit with stderr containing auth error', async () => {
    const proc = createMockProcess([], 1);
    // Push stderr data before the process closes
    const origEmit = proc.emit.bind(proc);
    proc.emit = function (event: string, ...args: any[]) {
      return origEmit(event, ...args);
    } as any;

    mockSpawn.mockReturnValue(proc);

    // Override: push stderr data before close
    const stderrProc = createMockProcess([], 1);
    // We need to push stderr data and then close
    const stderrStream = new Readable({ read() {} });
    const errProc = Object.assign(new EventEmitter(), {
      stdout: new Readable({ read() {} }),
      stderr: stderrStream,
      stdin: new EventEmitter(),
      killed: false,
      kill: jest.fn(function (this: any) { this.killed = true; }),
      pid: 12346,
    });

    setImmediate(() => {
      stderrStream.push('Error: unauthorized - invalid API key');
      stderrStream.push(null);
      errProc.stdout!.push(null);
      errProc.emit('close', 1);
    });

    mockSpawn.mockReturnValue(errProc);

    const ctx = makeCtx();
    const tools = createCliAgentTools(ctx as any);
    const codexTool = tools.find((t) => t.name === 'codex_cli')!;

    await expect(
      codexTool.execute(
        'tc-2',
        { prompt: 'Do something' },
        new AbortController().signal,
        jest.fn(),
      ),
    ).rejects.toThrow(/unauthorized|authentication/i);
  });

  it('throws when codex binary is not found', async () => {
    mockFindCodexBinary.mockRejectedValue(
      new Error('Codex CLI binary not found. Please install it'),
    );

    const ctx = makeCtx();
    const tools = createCliAgentTools(ctx as any);
    const codexTool = tools.find((t) => t.name === 'codex_cli')!;

    await expect(
      codexTool.execute(
        'tc-3',
        { prompt: 'Do something' },
        new AbortController().signal,
        jest.fn(),
      ),
    ).rejects.toThrow(/not found/i);
  });

  it('forwards IPC events for tool_start and stream_text', async () => {
    const jsonlLines = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-ipc-1' }),
      JSON.stringify({
        type: 'item.started',
        item: { id: 'cmd-1', type: 'commandExecution', command: 'npm test' },
      }),
      JSON.stringify({
        type: 'item.agentMessage.delta',
        delta: 'Running tests...',
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'msg-1', type: 'agentMessage', text: 'Tests passed.' },
      }),
      JSON.stringify({ type: 'turn.completed' }),
    ];

    const proc = createMockProcess(jsonlLines, 0);
    mockSpawn.mockReturnValue(proc);

    const ctx = makeCtx();
    const tools = createCliAgentTools(ctx as any);
    const codexTool = tools.find((t) => t.name === 'codex_cli')!;

    await codexTool.execute(
      'tc-4',
      { prompt: 'Run the tests' },
      new AbortController().signal,
      jest.fn(),
    );

    // Verify sendIpcEvent was called with tool_start
    expect(ctx.sendIpcEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool_start',
        toolName: 'Codex:command',
        toolCallId: 'cmd-1',
        message: 'npm test',
      }),
    );

    // Verify sendIpcEvent was called with stream_text
    expect(ctx.sendIpcEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'stream_text',
        delta: 'Running tests...',
      }),
    );
  });
});
