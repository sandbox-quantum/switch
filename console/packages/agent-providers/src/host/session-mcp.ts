import { randomBytes } from 'node:crypto';
import { serveMcpOverHttp } from '@sandboxaq/switch-agent-runtime/hosted';
import { z } from 'zod';
import type { HttpMcpServerSpec } from '../adapter';
import type { ParentChannel } from './session-channel';

const toolsSchema = z.array(
  z.object({
    name: z.string().min(1),
    description: z.string(),
    inputSchema: z.record(z.string(), z.unknown()),
  })
);

const toolResultSchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});

/**
 * The Switch tools, served to this session's CLI on loopback.
 *
 * Bound before the CLI starts, on a port the system picks, and answering only
 * the bearer token minted here for this run; a restart gets a new port and a
 * new token. Nothing is decided here: the tool list and every call go up the
 * IPC pipe to the parent, which holds the agent's connection and is the only
 * thing that talks to Switch. `spec` is what the CLI is given.
 */
export async function startSessionMcp(
  parent: ParentChannel
): Promise<{ spec: HttpMcpServerSpec; close: () => Promise<void> }> {
  const token = randomBytes(32).toString('hex');
  const server = await serveMcpOverHttp(token, {
    listTools: async () => toolsSchema.parse(await parent.ask({ type: 'tools' })),
    callTool: async (name, args) =>
      toolResultSchema.parse(await parent.ask({ type: 'tool', name, arguments: args })),
  });
  return {
    spec: { transport: 'http', url: server.url, headers: { Authorization: `Bearer ${token}` } },
    close: server.close,
  };
}
