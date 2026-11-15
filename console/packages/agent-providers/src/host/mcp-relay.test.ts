import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { serveMcpOverHttp } from '@sandboxaq/switch-agent-runtime/hosted';
import { expect, it, vi } from 'vitest';
import { relayMcpOverStdio } from './mcp-relay';

it('relays MCP on stdio to an HTTP server with its headers, answering a refused request with an error', async () => {
  const token = 'a'.repeat(64);
  const server = await serveMcpOverHttp(token, {
    listTools: async () => [],
    callTool: async (_name, args) => ({ content: [{ type: 'text', text: String(args.text) }] }),
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const relay = async (headers: Record<string, string>, message: Record<string, unknown>) => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const relayed = relayMcpOverStdio({
      stdin,
      stdout,
      env: { SWITCH_MCP_RELAY_URL: server.url, SWITCH_MCP_RELAY_HEADERS: JSON.stringify(headers) },
    });
    const replies = createInterface({ input: stdout })[Symbol.asyncIterator]();
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    const reply = JSON.parse((await replies.next()).value as string) as unknown;
    stdin.end();
    await relayed;
    return reply;
  };
  try {
    expect(
      await relay(
        { Authorization: `Bearer ${token}` },
        { id: 1, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } }
      )
    ).toEqual({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'hi' }] } });
    expect(await relay({}, { id: 2, method: 'tools/list' })).toMatchObject({
      id: 2,
      error: { code: -32603, message: expect.stringContaining('unauthorized') },
    });
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('switch: MCP relay:'));
  } finally {
    stderr.mockRestore();
    await server.close();
  }
});

it('offers a tool argument the agent cannot take under another name, and passes it on under its own', async () => {
  const token = 'b'.repeat(64);
  const server = await serveMcpOverHttp(token, {
    listTools: async () => [
      {
        name: 'list_templates',
        description: 'List templates.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' }, kind: { type: 'string' } },
          required: ['kind'],
        },
      },
    ],
    callTool: async (_name, args) => ({ content: [{ type: 'text', text: JSON.stringify(args) }] }),
  });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const relayed = relayMcpOverStdio({
    stdin,
    stdout,
    env: {
      SWITCH_MCP_RELAY_URL: server.url,
      SWITCH_MCP_RELAY_HEADERS: JSON.stringify({ Authorization: `Bearer ${token}` }),
      SWITCH_MCP_RELAY_RENAMED: '["kind"]',
    },
  });
  const replies = createInterface({ input: stdout })[Symbol.asyncIterator]();
  const ask = async (message: Record<string, unknown>) => {
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    return JSON.parse((await replies.next()).value as string) as unknown;
  };
  try {
    expect(await ask({ id: 1, method: 'tools/list' })).toMatchObject({
      result: {
        tools: [
          {
            name: 'list_templates',
            inputSchema: {
              properties: { query: { type: 'string' }, kind_: { type: 'string' } },
              required: ['kind_'],
            },
          },
        ],
      },
    });
    expect(
      await ask({
        id: 2,
        method: 'tools/call',
        params: { name: 'list_templates', arguments: { kind_: 'room', query: 'x' } },
      })
    ).toMatchObject({
      result: { content: [{ type: 'text', text: JSON.stringify({ kind: 'room', query: 'x' }) }] },
    });
  } finally {
    stdin.end();
    await relayed;
    await server.close();
  }
});
