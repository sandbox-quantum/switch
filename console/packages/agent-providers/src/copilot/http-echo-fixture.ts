import { randomBytes } from 'node:crypto';
import { serveMcpOverHttp } from '@sandboxaq/switch-agent-runtime/hosted';
import type { HttpMcpServerSpec } from '../adapter';

/** Copilot ACP accepts HTTP MCP servers, but rejects stdio server entries. */
export async function copilotEchoFixture() {
  const token = randomBytes(32).toString('hex');
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const server = await serveMcpOverHttp(token, {
    listTools: async () => [
      {
        name: 'switch_echo',
        description: 'Echo the given text for Switch conformance tests.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
    ],
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { content: [{ type: 'text', text: String(args.text) }] };
    },
  });
  const spec: HttpMcpServerSpec = {
    transport: 'http',
    url: server.url,
    headers: { Authorization: `Bearer ${token}` },
  };
  return { spec, calls, close: server.close };
}
