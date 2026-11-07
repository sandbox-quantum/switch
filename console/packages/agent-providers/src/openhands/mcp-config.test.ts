import { expect, it } from 'vitest';
import { OPENHANDS_MCP_SPEC } from './mcp-bridge';
import { prepareOpenHandsMcpServers } from './mcp-config';

const bridge = { command: '/host/node', args: ['/host/sidecar.mjs', '--mcp-bridge'] };

it('passes HTTP headers privately to the bridge without changing the server name', () => {
  const result = prepareOpenHandsMcpServers(
    {
      switch: {
        transport: 'http',
        url: 'http://127.0.0.1:1234/mcp',
        headers: { authorization: 'secret' },
      },
    },
    {},
    bridge
  );
  const spec = result.switch;
  expect(spec.transport).toBe('stdio');
  if (spec.transport !== 'stdio') throw new Error('expected stdio');
  expect(spec.command).toBe(bridge.command);
  expect(spec.args).toEqual([...bridge.args, 'openhands']);
  expect(JSON.stringify(spec.args)).not.toContain('secret');
  expect(JSON.parse(spec.env![OPENHANDS_MCP_SPEC])).toEqual({
    transport: 'http',
    url: 'http://127.0.0.1:1234/mcp',
    headers: { authorization: 'secret' },
  });
  expect(spec.env!.ELECTRON_RUN_AS_NODE).toBe('1');
});

it('preserves explicitly allowed stdio environment, with server values taking precedence', () => {
  const result = prepareOpenHandsMcpServers(
    {
      external: {
        transport: 'stdio',
        command: 'tool',
        args: ['serve'],
        envVars: ['TOKEN', 'MISSING'],
        env: { TOKEN: 'override' },
      },
    },
    { TOKEN: 'original', UNRELATED: 'private' },
    bridge
  );
  const spec = result.external;
  if (spec.transport !== 'stdio') throw new Error('expected stdio');
  expect(JSON.parse(spec.env![OPENHANDS_MCP_SPEC])).toEqual({
    transport: 'stdio',
    command: 'tool',
    args: ['serve'],
    env: { TOKEN: 'override' },
  });
  expect(spec.env![OPENHANDS_MCP_SPEC]).not.toContain('private');
});

it('requires a host bridge only when servers are configured and rejects oversized specs', () => {
  expect(prepareOpenHandsMcpServers({}, {}, undefined)).toEqual({});
  expect(() =>
    prepareOpenHandsMcpServers(
      { a: { transport: 'http', url: 'http://example.test' } },
      {},
      undefined
    )
  ).toThrow('requires the Switch host MCP bridge');
  expect(() =>
    prepareOpenHandsMcpServers(
      { a: { transport: 'http', url: 'http://example.test', headers: { x: 'é'.repeat(40000) } } },
      {},
      bridge
    )
  ).toThrow('configuration is too large');
});
