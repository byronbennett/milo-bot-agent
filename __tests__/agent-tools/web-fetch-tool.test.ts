import { createWebFetchTool } from '../../app/agent-tools/web-fetch-tool.js';

describe('web_fetch tool', () => {
  const tool = createWebFetchTool();

  it('has correct metadata', () => {
    expect(tool.name).toBe('web_fetch');
    expect(tool.label).toBe('Web Fetch');
    expect(tool.description).toContain('Fetch content from a URL');
  });

  it('fetches a URL and returns status + body', async () => {
    const result = await tool.execute('call-1', {
      url: 'https://httpbin.org/get',
    });

    const text = result.content[0].text;
    expect(text).toMatch(/^HTTP 200/);
    expect(text).toContain('Content-Type:');
    expect(text).toContain('"url"');
  });

  it('returns non-200 status without throwing', async () => {
    const result = await tool.execute('call-2', {
      url: 'https://httpbin.org/status/404',
    });

    const text = result.content[0].text;
    expect(text).toMatch(/^HTTP 404/);
  });

  it('supports POST with body', async () => {
    const result = await tool.execute('call-3', {
      url: 'https://httpbin.org/post',
      method: 'POST' as const,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });

    const text = result.content[0].text;
    expect(text).toMatch(/^HTTP 200/);
    expect(text).toContain('"hello"');
  });

  it('times out with short timeout', async () => {
    await expect(
      tool.execute('call-4', {
        url: 'https://httpbin.org/delay/10',
        timeout_ms: 500,
      }),
    ).rejects.toThrow(/timed out/i);
  });

  it('respects abort signal', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    await expect(
      tool.execute(
        'call-5',
        { url: 'https://httpbin.org/delay/10' },
        controller.signal,
      ),
    ).rejects.toThrow();
  });
});
