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
