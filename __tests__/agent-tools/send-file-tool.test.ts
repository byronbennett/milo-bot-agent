import { createSendFileTool, TEXT_EXTENSIONS, MAX_FILE_SIZE, getMimeType } from '../../app/agent-tools/send-file-tool.js';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { gunzipSync } from 'node:zlib';

const testDir = join(tmpdir(), 'send-file-tool-test');

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('createSendFileTool', () => {
  it('returns a tool with correct name and label', () => {
    const tool = createSendFileTool({ sendFile: () => {} });
    expect(tool.name).toBe('send_file');
    expect(tool.label).toBe('Send File');
  });
});

describe('TEXT_EXTENSIONS', () => {
  it('includes common text file extensions', () => {
    expect(TEXT_EXTENSIONS.has('.txt')).toBe(true);
    expect(TEXT_EXTENSIONS.has('.json')).toBe(true);
    expect(TEXT_EXTENSIONS.has('.html')).toBe(true);
    expect(TEXT_EXTENSIONS.has('.csv')).toBe(true);
    expect(TEXT_EXTENSIONS.has('.ts')).toBe(true);
    expect(TEXT_EXTENSIONS.has('.py')).toBe(true);
  });

  it('does not include binary extensions', () => {
    expect(TEXT_EXTENSIONS.has('.png')).toBe(false);
    expect(TEXT_EXTENSIONS.has('.jpg')).toBe(false);
    expect(TEXT_EXTENSIONS.has('.exe')).toBe(false);
    expect(TEXT_EXTENSIONS.has('.zip')).toBe(false);
  });
});

describe('getMimeType', () => {
  it('returns correct mime types for known extensions', () => {
    expect(getMimeType('.json')).toBe('application/json');
    expect(getMimeType('.html')).toBe('text/html');
    expect(getMimeType('.txt')).toBe('text/plain');
    expect(getMimeType('.csv')).toBe('text/csv');
    expect(getMimeType('.ts')).toBe('text/x-typescript');
    expect(getMimeType('.xml')).toBe('application/xml');
  });

  it('returns text/plain for unknown extensions', () => {
    expect(getMimeType('.unknown')).toBe('text/plain');
  });
});

describe('execute', () => {
  it('sends gzip+base64 encoded file contents via sendFile callback', async () => {
    const filePath = join(testDir, 'test.txt');
    writeFileSync(filePath, 'Hello, world!');

    let captured: any = null;
    const tool = createSendFileTool({
      sendFile: (opts) => { captured = opts; },
    });

    const result = await tool.execute('call-1', { filePath });
    expect(result.content[0].text).toContain('Sent');
    expect(captured).not.toBeNull();
    expect(captured.filename).toBe('test.txt');
    expect(captured.encoding).toBe('gzip+base64');
    expect(captured.mimeType).toBe('text/plain');
    expect(captured.sizeBytes).toBe(13);

    // Verify content round-trips: base64 → gunzip → original text
    const compressed = Buffer.from(captured.content, 'base64');
    const decompressed = gunzipSync(compressed).toString('utf-8');
    expect(decompressed).toBe('Hello, world!');
  });

  it('rejects non-text file extensions', async () => {
    const filePath = join(testDir, 'test.png');
    writeFileSync(filePath, 'not a real image');

    const tool = createSendFileTool({ sendFile: () => {} });
    const result = await tool.execute('call-1', { filePath });
    expect(result.content[0].text).toContain('not a supported text file');
  });

  it('rejects files exceeding size limit', async () => {
    const filePath = join(testDir, 'big.txt');
    writeFileSync(filePath, 'x'.repeat(MAX_FILE_SIZE + 1));

    const tool = createSendFileTool({ sendFile: () => {} });
    const result = await tool.execute('call-1', { filePath });
    expect(result.content[0].text).toContain('exceeds');
  });

  it('rejects nonexistent files', async () => {
    const tool = createSendFileTool({ sendFile: () => {} });
    const result = await tool.execute('call-1', { filePath: '/tmp/nonexistent-file-abc123.txt' });
    expect(result.content[0].text).toContain('not found');
  });

  it('sends JSON files with correct mime type', async () => {
    const filePath = join(testDir, 'data.json');
    writeFileSync(filePath, '{"key": "value"}');

    let captured: any = null;
    const tool = createSendFileTool({
      sendFile: (opts) => { captured = opts; },
    });

    await tool.execute('call-1', { filePath });
    expect(captured.mimeType).toBe('application/json');
    expect(captured.filename).toBe('data.json');
  });

  it('handles files with no extension by rejecting them', async () => {
    const filePath = join(testDir, 'noext');
    writeFileSync(filePath, 'some content');

    const tool = createSendFileTool({ sendFile: () => {} });
    const result = await tool.execute('call-1', { filePath });
    expect(result.content[0].text).toContain('not a supported text file');
  });
});
