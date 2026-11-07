import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { createOpenHandsMcpBridge, runOpenHandsMcpBridge, OPENHANDS_MCP_SPEC } from './mcp-bridge';

class MemoryTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sent: JSONRPCMessage[] = [];
  started = 0;
  closed = 0;
  version?: string;
  async start() {
    this.started++;
  }
  async close() {
    this.closed++;
    this.onclose?.();
  }
  async send(message: JSONRPCMessage) {
    this.sent.push(message);
  }
  setProtocolVersion(version: string) {
    this.version = version;
  }
  receive(message: JSONRPCMessage) {
    this.onmessage?.(message);
  }
}

const req = (id: number, method: string, params: Record<string, unknown> = {}): JSONRPCMessage => ({
  jsonrpc: '2.0',
  id,
  method,
  params,
});
const res = (id: number, result: Record<string, unknown>): JSONRPCMessage => ({
  jsonrpc: '2.0',
  id,
  result,
});
const msg = (method: string, params: Record<string, unknown> = {}): JSONRPCMessage => ({
  jsonrpc: '2.0',
  method,
  params,
});

async function fixture() {
  const inbound = new MemoryTransport();
  const outbound = new MemoryTransport();
  const bridge = createOpenHandsMcpBridge(inbound, outbound);
  await bridge.start();
  return { inbound, outbound, bridge };
}

describe('OpenHands MCP bridge', () => {
  it('preserves initialization, pagination, required/optional schema and translates calls', async () => {
    const { inbound, outbound, bridge } = await fixture();
    inbound.receive(req(1, 'initialize'));
    outbound.receive(res(1, { protocolVersion: '2025-06-18' }));
    expect(outbound.version).toBe('2025-06-18');
    expect(inbound.sent.at(-1)).toEqual(res(1, { protocolVersion: '2025-06-18' }));
    inbound.receive(req(2, 'tools/list', { cursor: 'one' }));
    outbound.receive(
      res(2, {
        nextCursor: 'two',
        _meta: { a: 1 },
        tools: [
          {
            name: 'required',
            inputSchema: {
              type: 'object',
              properties: {
                kind: { type: 'string' },
                switch_mcp_kind: { type: 'number' },
                nested: { type: 'object', properties: { kind: { type: 'string' } } },
              },
              required: ['kind'],
            },
          },
          {
            name: 'optional',
            inputSchema: { type: 'object', properties: { kind: { type: 'string' } } },
          },
          {
            name: 'ordinary',
            inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
          },
        ],
      })
    );
    const result = inbound.sent.at(-1) as unknown as {
      result: {
        nextCursor: string;
        _meta: unknown;
        tools: Array<{
          name: string;
          inputSchema: { properties: Record<string, unknown>; required?: string[] };
        }>;
      };
    };
    expect(result.result.nextCursor).toBe('two');
    expect(result.result._meta).toEqual({ a: 1 });
    expect(result.result.tools[0]!.inputSchema.required).toEqual(['switch_mcp_kind_']);
    expect(result.result.tools[0]!.inputSchema.properties).toEqual({
      switch_mcp_kind: { type: 'number' },
      switch_mcp_kind_: { type: 'string' },
      nested: { type: 'object', properties: { kind: { type: 'string' } } },
    });
    expect(result.result.tools[1]!.inputSchema.required).toBeUndefined();
    expect(result.result.tools[2]!.inputSchema.properties).toEqual({ x: { type: 'string' } });
    inbound.receive(
      req(3, 'tools/call', {
        name: 'required',
        arguments: { switch_mcp_kind_: 'room', switch_mcp_kind: 2, nested: { kind: 'inner' } },
      })
    );
    expect(outbound.sent.at(-1)).toEqual(
      req(3, 'tools/call', {
        name: 'required',
        arguments: { kind: 'room', switch_mcp_kind: 2, nested: { kind: 'inner' } },
      })
    );
    await bridge.close();
    expect(inbound.closed).toBe(1);
    expect(outbound.closed).toBe(1);
  });

  it('relays arbitrary requests, errors, notifications, progress and cancellation without mutation', async () => {
    const { inbound, outbound, bridge } = await fixture();
    const original = [
      req(5, 'resources/read', { uri: 'file:///synthetic' }),
      msg('notifications/cancelled', { requestId: 5, reason: 'cancelled' }),
      req(6, 'prompts/get', { name: 'p' }),
    ];
    for (const event of original) inbound.receive(event);
    expect(outbound.sent).toEqual(original);
    const upstream: JSONRPCMessage[] = [
      msg('notifications/progress', { progressToken: 'p', progress: 1 }),
      req(7, 'sampling/createMessage', { messages: [] }),
      {
        jsonrpc: '2.0',
        id: 5,
        error: { code: -32000, message: 'upstream error', data: { retry: true } },
      },
      msg('notifications/tools/list_changed'),
    ];
    for (const event of upstream) outbound.receive(event);
    expect(inbound.sent).toEqual(upstream);
    const answer = res(7, { role: 'assistant', content: { type: 'text', text: 'ok' } });
    inbound.receive(answer);
    expect(outbound.sent.at(-1)).toEqual(answer);
    await bridge.close();
  });

  it('fails closed when a previously advertised alias collides or becomes stale', async () => {
    const { inbound, outbound, bridge } = await fixture();
    inbound.receive(req(1, 'tools/list'));
    outbound.receive(
      res(1, {
        tools: [
          {
            name: 'tool',
            inputSchema: { type: 'object', properties: { kind: { type: 'string' } } },
          },
        ],
      })
    );
    inbound.receive(req(2, 'tools/list'));
    outbound.receive(
      res(2, {
        tools: [
          {
            name: 'tool',
            inputSchema: {
              type: 'object',
              properties: { kind: { type: 'string' }, switch_mcp_kind: { type: 'string' } },
            },
          },
        ],
      })
    );
    expect(inbound.sent.at(-1)).toMatchObject({
      id: 2,
      error: { message: 'The MCP tool schema changed incompatibly.' },
    });
    inbound.receive(req(3, 'tools/list'));
    outbound.receive(
      res(3, {
        tools: [
          {
            name: 'tool',
            inputSchema: { type: 'object', properties: { other: { type: 'string' } } },
          },
        ],
      })
    );
    const before = outbound.sent.length;
    inbound.receive(
      req(4, 'tools/call', { name: 'tool', arguments: { switch_mcp_kind: 'stale' } })
    );
    expect(outbound.sent).toHaveLength(before);
    expect(inbound.sent.at(-1)).toMatchObject({
      id: 4,
      error: { message: 'Ambiguous MCP tool arguments.' },
    });
    await bridge.close();
  });

  it.each([
    { dependentRequired: { kind: ['other'] } },
    { dependencies: { kind: ['other'] } },
    { dependentSchemas: { kind: { required: ['other'] } } },
    { oneOf: [{ required: ['kind'] }] },
    { if: { required: ['kind'] }, then: { required: ['other'] } },
    { patternProperties: { '^kind$': { type: 'string' } } },
    { propertyNames: { enum: ['kind'] } },
    { unevaluatedProperties: false },
    { enum: [{ kind: 'room' }] },
    { const: { kind: 'room' } },
  ])('fails closed for constraints that cannot safely rename kind: %o', async (constraint) => {
    const { inbound, outbound, bridge } = await fixture();
    inbound.receive(req(1, 'tools/list'));
    outbound.receive(
      res(1, {
        tools: [
          {
            name: 'tool',
            inputSchema: {
              type: 'object',
              properties: { kind: { type: 'string' } },
              ...constraint,
            },
          },
        ],
      })
    );
    expect(inbound.sent.at(-1)).toMatchObject({
      id: 1,
      error: { message: 'The MCP tool schema changed incompatibly.' },
    });
    await bridge.close();
  });

  it.each([
    { oneOf: [{ properties: { kind: { type: 'string' } } }] },
    { allOf: [{ not: { properties: { kind: { type: 'string' } } } }] },
    { $ref: '#/$defs/tool' },
  ])('fails closed when kind may be defined in a root branch or reference: %o', async (schema) => {
    const { inbound, outbound, bridge } = await fixture();
    inbound.receive(req(1, 'tools/list'));
    outbound.receive(
      res(1, { tools: [{ name: 'tool', inputSchema: { type: 'object', ...schema } }] })
    );
    expect(inbound.sent.at(-1)).toMatchObject({
      id: 1,
      error: { message: 'The MCP tool schema changed incompatibly.' },
    });
    await bridge.close();
  });

  it('fails closed when a nested schema reference could target the renamed property', async () => {
    const { inbound, outbound, bridge } = await fixture();
    inbound.receive(req(1, 'tools/list'));
    outbound.receive(
      res(1, {
        tools: [
          {
            name: 'tool',
            inputSchema: {
              type: 'object',
              properties: { kind: { type: 'string' }, other: { $ref: '#/properties/kind' } },
            },
          },
        ],
      })
    );
    expect(inbound.sent.at(-1)).toMatchObject({
      id: 1,
      error: { message: 'The MCP tool schema changed incompatibly.' },
    });
    await bridge.close();
  });

  it('does not disclose sensitive startup errors', async () => {
    const spy = vi
      .spyOn(StdioClientTransport.prototype, 'start')
      .mockRejectedValue(new Error('secret-url secret-command secret-token'));
    try {
      const spec = JSON.stringify({
        transport: 'stdio',
        command: 'secret-command',
        args: ['secret-token'],
        env: {},
      });
      const failure = await runOpenHandsMcpBridge({ [OPENHANDS_MCP_SPEC]: spec }).catch(
        (error: unknown) => error
      );
      expect(String(failure)).toBe('Error: OpenHands MCP bridge could not start.');
    } finally {
      spy.mockRestore();
    }
  });

  it('does not commit partial alias changes when a tools page fails', async () => {
    const { inbound, outbound, bridge } = await fixture();
    inbound.receive(req(1, 'tools/list'));
    outbound.receive(
      res(1, {
        tools: [{ name: 'tool', inputSchema: { type: 'object', properties: { kind: {} } } }],
      })
    );
    inbound.receive(req(2, 'tools/list'));
    outbound.receive(
      res(2, {
        tools: [
          { name: 'tool', inputSchema: { type: 'object', properties: { other: {} } } },
          {
            name: 'bad',
            inputSchema: { type: 'object', properties: { kind: {} }, propertyNames: {} },
          },
        ],
      })
    );
    expect(inbound.sent.at(-1)).toMatchObject({ id: 2, error: {} });
    inbound.receive(req(3, 'tools/call', { name: 'tool', arguments: { switch_mcp_kind: 'room' } }));
    expect(outbound.sent.at(-1)).toEqual(
      req(3, 'tools/call', { name: 'tool', arguments: { kind: 'room' } })
    );
    await bridge.close();
  });

  it('never silently forwards conflicting kind arguments', async () => {
    const { inbound, outbound, bridge } = await fixture();
    inbound.receive(req(1, 'tools/list'));
    outbound.receive(
      res(1, {
        tools: [
          {
            name: 'tool',
            inputSchema: { type: 'object', properties: { kind: { type: 'string' } } },
          },
        ],
      })
    );
    const before = outbound.sent.length;
    inbound.receive(
      req(2, 'tools/call', { name: 'tool', arguments: { kind: 'x', switch_mcp_kind: 'y' } })
    );
    expect(outbound.sent).toHaveLength(before);
    expect(inbound.sent.at(-1)).toMatchObject({
      id: 2,
      error: { message: 'Ambiguous MCP tool arguments.' },
    });
    await bridge.close();
  });

  it('bounds correlation state and closes both transports on disconnect', async () => {
    const { inbound, outbound } = await fixture();
    for (let i = 0; i < 1024; i++) inbound.receive(req(i, 'tools/list'));
    inbound.receive(req(1024, 'tools/list'));
    expect(outbound.sent).toHaveLength(1024);
    expect(inbound.sent.at(-1)).toMatchObject({
      id: 1024,
      error: { message: 'Too many outstanding MCP requests.' },
    });
    inbound.onclose?.();
    await vi.waitFor(() => {
      expect(inbound.closed).toBe(1);
      expect(outbound.closed).toBe(1);
    });
  });

  it('preserves explicitly configured stdio environment while excluding internal bridge secrets', async () => {
    const outgoingStart = vi.spyOn(StdioClientTransport.prototype, 'start').mockResolvedValue();
    const incomingStart = vi.spyOn(StdioServerTransport.prototype, 'start').mockResolvedValue();
    try {
      const childBridge = await runOpenHandsMcpBridge({
        [OPENHANDS_MCP_SPEC]: JSON.stringify({
          transport: 'stdio',
          command: 'synthetic-command',
          args: ['first'],
          env: {
            PATH: '/synthetic/bin',
            CUSTOM: 'value',
            SWITCH_OPENHANDS_MCP_SPEC: 'secret',
          },
        }),
      });
      const params = (outgoingStart.mock.instances[0] as unknown as { _serverParams: unknown })
        ._serverParams;
      expect(params).toEqual({
        command: 'synthetic-command',
        args: ['first'],
        env: { PATH: '/synthetic/bin', CUSTOM: 'value' },
        stderr: 'pipe',
      });
      expect(incomingStart).toHaveBeenCalledOnce();
      await childBridge.close();
    } finally {
      outgoingStart.mockRestore();
      incomingStart.mockRestore();
    }
  });

  it.each(['eof', 'SIGTERM', 'SIGINT'] as const)(
    'closes an actual stdio upstream on %s without leaking bridge configuration',
    async (shutdown) => {
      const bridgeModule = new URL('./mcp-bridge.ts', import.meta.url).href;
      const upstreamScript = `
        process.stdin.on('data', () => {
          process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{
            pid:process.pid,custom:process.env.CUSTOM,privateSpec:process.env.SWITCH_OPENHANDS_MCP_SPEC ?? null
          }}) + '\\n');
        });
        setInterval(() => {}, 1000);
      `;
      const spec = JSON.stringify({
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', upstreamScript],
        env: { CUSTOM: 'retained', SWITCH_OPENHANDS_MCP_SPEC: 'do-not-leak' },
      });
      const child = spawn(
        process.execPath,
        [
          '--experimental-strip-types',
          '--input-type=module',
          '-e',
          `import {runOpenHandsMcpBridge} from ${JSON.stringify(bridgeModule)}; await runOpenHandsMcpBridge();`,
        ],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, [OPENHANDS_MCP_SPEC]: spec, NODE_NO_WARNINGS: '1' },
        }
      );
      let upstreamPid: number | undefined;
      try {
        const line = once(createInterface({ input: child.stdout }), 'line');
        const exited = once(child, 'exit');
        child.stdin.write(JSON.stringify(req(1, 'initialize')) + '\n');
        const [firstLine] = await Promise.race([
          line,
          exited.then(() => {
            throw new Error('bridge exited before replying');
          }),
        ]);
        const response = JSON.parse(String(firstLine));
        upstreamPid = response.result.pid;
        expect(response.result).toEqual({
          pid: expect.any(Number),
          custom: 'retained',
          privateSpec: null,
        });
        if (shutdown === 'eof') child.stdin.end();
        else child.kill(shutdown);
        expect(await exited).toEqual([0, null]);
        expect(() => process.kill(upstreamPid!, 0)).toThrow();
      } finally {
        child.kill('SIGKILL');
        if (upstreamPid) {
          try {
            process.kill(upstreamPid, 'SIGKILL');
          } catch {
            /* already exited */
          }
        }
      }
    },
    15_000
  );

  it('rejects malformed private configuration without exposing its contents', async () => {
    await expect(
      runOpenHandsMcpBridge({ [OPENHANDS_MCP_SPEC]: 'sensitive-invalid' })
    ).rejects.toThrow('Missing or invalid');
    await expect(
      runOpenHandsMcpBridge({
        [OPENHANDS_MCP_SPEC]: JSON.stringify({
          transport: 'http',
          url: 'not-a-url',
          headers: { Authorization: 'secret' },
        }),
      })
    ).rejects.toThrow('Missing or invalid');
  });
});
