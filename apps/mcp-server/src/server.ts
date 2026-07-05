import { MeritedClient } from '@merited/sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TOOLS } from './tools.js';

/**
 * The Merited MCP server (PH1-6, B10). Registers the three tools over an
 * `McpServer`; the SDK client it drives is an ORDINARY registered agent
 * (P5) — credentials from env, no privileged Core access. Transport is the
 * caller's choice (stdio for local inspectors, streamable-HTTP for hosted).
 */
export interface McpServerOptions {
  /** Core base URL the SDK talks to. */
  baseUrl: string;
  /** Agent api key (`mak_…`) — the server acts as this one agent. */
  agentApiKey?: string;
}

export const buildMcpServer = (options: McpServerOptions): McpServer => {
  const client = new MeritedClient({
    baseUrl: options.baseUrl,
    ...(options.agentApiKey ? { apiKey: options.agentApiKey } : {}),
  });

  const server = new McpServer({ name: 'merited', version: '0.1.0' });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        // McpServer builds the tool's JSON Schema from this Zod shape — the
        // contracts schema IS the tool schema (single source, PH1-6).
        inputSchema: (tool.inputSchema as unknown as { shape: z.ZodRawShape }).shape,
      },
      async (args: unknown) => {
        try {
          return await tool.handler(args, client);
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Merited error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        }
      },
    );
  }
  return server;
};
