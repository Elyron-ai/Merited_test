import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildMcpServer } from './server.js';

export { buildMcpServer, type McpServerOptions } from './server.js';
export { TOOLS } from './tools.js';

/**
 * Entry point (PH1-6): boot over stdio for a local MCP inspector.
 * `MERITED_CORE_URL` + `MERITED_AGENT_API_KEY` name the Core and the
 * agent identity (streamable-HTTP transport is wired the same way behind
 * a hosted deployment — the server object is transport-agnostic).
 */
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const baseUrl = process.env['MERITED_CORE_URL'] ?? 'http://localhost:3100';
  const agentApiKey = process.env['MERITED_AGENT_API_KEY'];
  const server = buildMcpServer({ baseUrl, ...(agentApiKey ? { agentApiKey } : {}) });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
