import { Type } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';

const WebFetchParams = Type.Object({
  url: Type.String({ description: 'The URL to fetch' }),
  method: Type.Optional(
    Type.Union(
      [Type.Literal('GET'), Type.Literal('POST'), Type.Literal('PUT'), Type.Literal('DELETE')],
      { description: 'HTTP method (default: GET)' },
    ),
  ),
  headers: Type.Optional(
    Type.Record(Type.String(), Type.String(), { description: 'Request headers as key-value pairs' }),
  ),
  body: Type.Optional(Type.String({ description: 'Request body (for POST/PUT)' })),
  timeout_ms: Type.Optional(
    Type.Number({ description: 'Request timeout in milliseconds (default: 30000)' }),
  ),
});

export function createWebFetchTool(): AgentTool<typeof WebFetchParams> {
  return {
    name: 'web_fetch',
    label: 'Web Fetch',
    description:
      'Fetch content from a URL via HTTP. Use this instead of curl in bash for making HTTP requests. Returns the response status, headers, and body. Supports GET, POST, PUT, DELETE with configurable timeout (default 30s).',
    parameters: WebFetchParams,
    execute: async (_toolCallId, params, signal) => {
      const timeout = params.timeout_ms ?? 30_000;
      const method = params.method ?? 'GET';

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      if (signal) {
        const abortSignal = signal as AbortSignal;
        if (abortSignal.aborted) {
          controller.abort();
        } else {
          abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
        }
      }

      try {
        const response = await fetch(params.url, {
          method,
          headers: params.headers,
          body: params.body,
          signal: controller.signal,
        });

        const contentType = response.headers.get('content-type') ?? '';
        const text = await response.text();

        const maxLength = 50_000;
        const truncated = text.length > maxLength;
        const body = truncated ? text.slice(0, maxLength) + '\n\n... (truncated)' : text;

        return {
          content: [
            {
              type: 'text',
              text: `HTTP ${response.status} ${response.statusText}\nContent-Type: ${contentType}\n\n${body}`,
            },
          ],
          details: { url: params.url, status: response.status, truncated },
        };
      } catch (err) {
        if (controller.signal.aborted) {
          throw new Error(`Request timed out after ${timeout}ms: ${params.url}`);
        }
        throw new Error(`Fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        clearTimeout(timeoutId);
      }
    },
  };
}
