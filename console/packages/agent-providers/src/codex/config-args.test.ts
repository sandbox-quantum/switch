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
      }).args
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
    ).toEqual({
      args: [
        '-c',
        'mcp_servers.switch.url="https://example.test/mcp"',
        '-c',
        'mcp_servers.switch.http_headers={ "A" = "b" }',
        '-c',
        'mcp_servers.switch.default_tools_approval_mode="approve"',
      ],
      env: {},
    });
  });

  it('hands a bearer token over by variable name, keeping it off the command line', () => {
    const { args, env } = mcpServerConfigArgs({
      switch: {
        transport: 'http',
        url: 'http://127.0.0.1:4567/mcp',
        headers: { Authorization: 'Bearer secret-token', 'X-Other': 'x' },
      },
    });
    expect(args).toEqual([
      '-c',
      'mcp_servers.switch.url="http://127.0.0.1:4567/mcp"',
      '-c',
      'mcp_servers.switch.bearer_token_env_var="SWITCH_MCP_SWITCH_BEARER_TOKEN"',
      '-c',
      'mcp_servers.switch.http_headers={ "X-Other" = "x" }',
      '-c',
      'mcp_servers.switch.default_tools_approval_mode="approve"',
    ]);
    expect(args.join(' ')).not.toContain('secret-token');
    expect(env).toEqual({ SWITCH_MCP_SWITCH_BEARER_TOKEN: 'secret-token' });
  });

  it('omits empty env and headers', () => {
    const { args } = mcpServerConfigArgs({
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

it('forwards MCP credentials by name without putting values in argv', () => {
  const { args } = mcpServerConfigArgs({
    switch: { transport: 'stdio', command: 'node', args: [], envVars: ['SWITCH_API_TOKEN'] },
  });
  expect(args).toContain('mcp_servers.switch.env_vars=["SWITCH_API_TOKEN"]');
  expect(args.some((arg) => arg.startsWith('mcp_servers.switch.env='))).toBe(false);
});
