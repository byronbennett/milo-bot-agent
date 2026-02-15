import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createFileTools } from '../../app/agent-tools/file-tools.js';

describe('File Tools', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'milo-tools-'));
  });

  it('read_file reads a file', async () => {
    writeFileSync(join(tmpDir, 'test.txt'), 'hello world');
    const tools = createFileTools(tmpDir);
    const readTool = tools.find((t) => t.name === 'read_file')!;

    const result = await readTool.execute('tc1', { path: 'test.txt' }, new AbortController().signal);
    expect(result.content[0]).toEqual({ type: 'text', text: 'hello world' });
  });

  it('write_file creates a file', async () => {
    const tools = createFileTools(tmpDir);
    const writeTool = tools.find((t) => t.name === 'write_file')!;

    await writeTool.execute('tc1', { path: 'new.txt', content: 'created' }, new AbortController().signal);

    const { readFileSync } = await import('fs');
    expect(readFileSync(join(tmpDir, 'new.txt'), 'utf-8')).toBe('created');
  });

  it('read_file throws for missing file', async () => {
    const tools = createFileTools(tmpDir);
    const readTool = tools.find((t) => t.name === 'read_file')!;

    await expect(
      readTool.execute('tc1', { path: 'nope.txt' }, new AbortController().signal)
    ).rejects.toThrow();
  });
});
