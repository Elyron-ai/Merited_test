import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { buildMcpServer } from '../src/server.js';

/**
 * W9/#30: a tool handler that throws an UNEXPECTED error (a network/internal
 * failure, not a MeritedApiError) must not echo that error's message — it could
 * carry infra detail (hosts, ports, ECONNREFUSED, stack fragments) into the
 * agent's context. Only the SDK's typed, already-redacted MeritedApiError is
 * surfaced verbatim. No Core/trio/DB needed: a dead-port base URL guarantees a
 * non-API fetch failure.
 */
describe('MCP error redaction (W9/#30)', () => {
  it('redacts an unexpected (non-API) error to a generic line', async () => {
    // 127.0.0.1:1 refuses instantly → the SDK fetch throws a network error,
    // which is NOT a MeritedApiError.
    const server = buildMcpServer({ baseUrl: 'http://127.0.0.1:1', agentApiKey: 'mak_test' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'redaction-test', version: '1.0.0' });
    await client.connect(clientTransport);

    try {
      const result = (await client.callTool({
        name: 'search_offers',
        arguments: { text: 'anything' },
      })) as { isError?: boolean; content: Array<{ text?: string }> };

      expect(result.isError).toBe(true);
      const text = result.content[0]!.text ?? '';
      expect(text).toBe('Merited error: an unexpected error occurred');
      // no infra detail leaked
      expect(text).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|fetch failed|localhost|:1\b/i);
    } finally {
      await client.close();
    }
  });
});
