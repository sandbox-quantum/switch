import { describe, expect, it } from 'vitest';
import { featureArgs, mcpServerConfigArgs } from './config-args';

describe('mcpServerConfigArgs', () => {
  it('turns a stdio server into TOML config overrides', () => {
    expect(
      mcpServerConfigArgs({
        switch_echo: {
          transport: 'stdio',
          command: '/usr/bin/node',
          args: ['/tmp/echo.mjs', '--flag'],
          env: { SWITCH_API_TOKEN: 'shh' },
        },
      })
    ).toEqual([
      '-c',
      'mcp_servers.switch_echo.command="/usr/bin/node"',
      '-c',
      'mcp_servers.switch_echo.args=["/tmp/echo.mjs", "--flag"]',
      '-c',
      'mcp_servers.switch_echo.env={ "SWITCH_API_TOKEN" = "shh" }',
      '-c',
      'mcp_servers.switch_echo.default_tools_approval_mode="approve"',
    ]);
  });

  it('turns an http server into url and header overrides', () => {
    expect(
      mcpServerConfigArgs({
        switch: { transport: 'http', url: 'https://example.test/mcp', headers: { A: 'b' } },
      })
    ).toEqual([
      '-c',
      'mcp_servers.switch.url="https://example.test/mcp"',
      '-c',
      'mcp_servers.switch.http_headers={ "A" = "b" }',
      '-c',
      'mcp_servers.switch.default_tools_approval_mode="approve"',
    ]);
  });

  it('omits empty env and headers', () => {
    const args = mcpServerConfigArgs({
      a: { transport: 'stdio', command: 'node', args: [], env: {} },
    });
    expect(args.join(' ')).not.toContain('.env=');
  });

  it('refuses a name that cannot be a TOML bare key', () => {
    expect(() =>
      mcpServerConfigArgs({ 'switch.echo': { transport: 'stdio', command: 'node', args: [] } })
    ).toThrow(/cannot be expressed as a Codex config key/);
  });
});

describe('featureArgs', () => {
  it('emits enable and disable pairs', () => {
    expect(featureArgs({ multi_agent_v2: true, hooks: false })).toEqual([
      '--enable',
      'multi_agent_v2',
      '--disable',
      'hooks',
    ]);
  });
});
