import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CallerContext,
  callOperation,
  serveMcpOverHttp,
  SwitchToolCatalog,
  type ToolDefinition,
} from './hosted';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function context(overrides: Partial<CallerContext> = {}): CallerContext {
  const dir = mkdtempSync(join(tmpdir(), 'hosted-test-'));
  dirs.push(dir);
  return {
    identity: { endpoint: 'https://switch.test', agentId: 'agent', token: 'agent-token' },
    connectionId: 'connection',
    selector: {
      'X-Switch-Session-Id': 'session',
      'X-Switch-Session-Host-Id': 'host',
      'X-Switch-Session-Epoch': 'epoch',
    },
    room: 'room',
    mediaDir: join(dir, 'media'),
    cwd: dir,
    deadConnection: (operation) => `dead: ${operation}`,
    ...overrides,
  };
}

describe('an operation call', () => {
  it('is made as the caller: its connection and the session selector', async () => {
    const fetchMock = vi.fn(async () => Response.json({ result: { room_id: 'room' } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await callOperation(context(), 'connect_to_room', { room_id: 'room' });
    expect(result.structuredContent).toEqual({ room_id: 'room' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://switch.test/agents/agent/ops/connect_to_room');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer agent-token',
      'X-Switch-Connection-Id': 'connection',
      'X-Switch-Session-Id': 'session',
      'X-Switch-Session-Host-Id': 'host',
      'X-Switch-Session-Epoch': 'epoch',
    });
  });

  it('words a connection Switch no longer knows as the caller says', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('connection connection is not open', { status: 409 }))
    );
    const result = await callOperation(context(), 'post_message', {});
    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'dead: post_message' }],
    });
  });
});

describe('the tool catalog', () => {
  const catalog = new SwitchToolCatalog([
    { name: 'post_message', description: 'Post.', input_schema: { type: 'object' } },
  ]);

  it('lists every operation and the two attachment tools', () => {
    expect(catalog.tools().map((tool) => tool.name)).toEqual([
      'post_message',
      'download_attachment',
      'send_attachment',
    ]);
  });

  it('refuses a tool it does not serve', async () => {
    await expect(catalog.call(context(), 'nope', {})).rejects.toThrow('Unknown tool: nope');
  });

  it('reads a relative attachment path against the session, not this process', async () => {
    const fetchMock = vi.fn(async (_url: string) => Response.json({ event_id: 'event' }));
    vi.stubGlobal('fetch', fetchMock);
    const ctx = context();
    writeFileSync(join(ctx.cwd, 'notes.md'), 'hello');
    const result = await catalog.call(ctx, 'send_attachment', { path: 'notes.md' });
    expect(result.isError).toBeUndefined();
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://switch.test/agents/agent/rooms/room/media'
    );
  });

  it('downloads into the caller’s media directory', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bytes'))
    );
    const ctx = context();
    const result = await catalog.call(ctx, 'download_attachment', {
      mxc: 'mxc://server/media-id',
      filename: 'a.txt',
    });
    const written = result.content[0]!.text;
    expect(written.startsWith(ctx.mediaDir)).toBe(true);
    expect(readFileSync(written, 'utf8')).toBe('bytes');
  });
});

describe('the loopback MCP server', () => {
  const tools: ToolDefinition[] = [
    { name: 'echo', description: 'Echo.', inputSchema: { type: 'object' } },
  ];

  async function serve(token: string, callTool = vi.fn()) {
    return serveMcpOverHttp(token, { listTools: async () => tools, callTool });
  }

  async function connect(url: string, token: string): Promise<Client> {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      })
    );
    return client;
  }

  it('refuses a caller without the token', async () => {
    const token = randomBytes(32).toString('hex');
    const server = await serve(token);
    try {
      expect(new URL(server.url).hostname).toBe('127.0.0.1');
      const none = await fetch(server.url, { method: 'POST', body: '{}' });
      expect(none.status).toBe(401);
      const wrong = await fetch(server.url, {
        method: 'POST',
        body: '{}',
        headers: { Authorization: `Bearer ${randomBytes(32).toString('hex')}` },
      });
      expect(wrong.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('lists the tools and hands each call over', async () => {
    const token = randomBytes(32).toString('hex');
    const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => ({
      content: [{ type: 'text' as const, text: `${name}:${JSON.stringify(args)}` }],
    }));
    const server = await serve(token, callTool);
    const client = await connect(server.url, token);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['echo']);
      const result = await client.callTool({ name: 'echo', arguments: { a: 1 } });
      expect(result.content).toEqual([{ type: 'text', text: 'echo:{"a":1}' }]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('answers a call that fails as an error result naming why', async () => {
    const token = randomBytes(32).toString('hex');
    const server = await serve(
      token,
      vi.fn(async () => {
        throw new Error('the watcher is not running');
      })
    );
    const client = await connect(server.url, token);
    try {
      const result = await client.callTool({ name: 'echo', arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('the watcher is not running');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
