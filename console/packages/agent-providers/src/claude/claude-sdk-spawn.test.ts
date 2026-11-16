import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { query, type SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from './claude-adapter';
import { claudeMcpLaunch } from './claude-mapping';

/** A stand-in for the CLI that exits 2 unless every named variable is set, and otherwise waits. */
function spawnStandIn(options: SpawnOptions, required: string[]): ChildProcessWithoutNullStreams {
  const check = required.map((name) => `!process.env[${JSON.stringify(name)}]`).join(' || ');
  return spawn(
    process.execPath,
    ['-e', `if (${check || 'false'}) process.exit(2); process.stdin.resume()`],
    { env: options.env, stdio: 'pipe' }
  );
}

describe('Claude SDK process boundary', () => {
  it('keeps provider and MCP credentials in the child environment and out of argv', async () => {
    const providerKey = 'test-only-not-a-real-provider-key';
    const switchToken = 'test-only-not-a-real-switch-token';
    const env = {
      HOME: '/tmp/test-only-claude-home',
      ANTHROPIC_API_KEY: providerKey,
      SWITCH_API_TOKEN: switchToken,
    };
    const launch = claudeMcpLaunch(
      {
        switch: {
          transport: 'stdio',
          command: 'node',
          args: ['runtime.mjs'],
          envVars: ['SWITCH_API_TOKEN'],
        },
      },
      env
    );

    let spawned: SpawnOptions | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;
    const running = query({
      prompt: (async function* () {})(),
      options: {
        env: launch.env,
        mcpServers: launch.mcpServers,
        pathToClaudeCodeExecutable: '/test-only/claude',
        spawnClaudeCodeProcess: (options) => {
          spawned = options;
          child = spawnStandIn(options, ['ANTHROPIC_API_KEY', 'SWITCH_API_TOKEN']);
          return child;
        },
      },
    });

    expect(spawned).toBeDefined();
    const processOptions = spawned!;
    const exited = new Promise<number | null>((resolve) =>
      child!.once('exit', (code) => resolve(code))
    );

    try {
      const argv = [processOptions.command, ...processOptions.args].join('\0');
      expect(argv).not.toContain(providerKey);
      expect(argv).not.toContain(switchToken);
      expect(processOptions.env.ANTHROPIC_API_KEY).toBe(providerKey);
      expect(processOptions.env.SWITCH_API_TOKEN).toBe(switchToken);

      const configIndex = processOptions.args.indexOf('--mcp-config');
      expect(configIndex).toBeGreaterThanOrEqual(0);
      expect(JSON.parse(processOptions.args[configIndex + 1]!)).toEqual({
        mcpServers: {
          switch: {
            type: 'stdio',
            command: 'node',
            args: ['runtime.mjs'],
            env: {
              SWITCH_API_TOKEN: '${SWITCH_API_TOKEN}',
            },
          },
        },
      });
    } finally {
      running.close();
      expect(await exited).toBe(0);
    }
  });

  it('starts a session with every MCP bearer in the environment, named from the config, and none in argv', async () => {
    const switchBearer = 'Bearer test-only-switch-session-bearer';
    const connectorBearer = 'Bearer test-only-connector-bearer';
    let spawned: SpawnOptions | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;
    const adapter = new ClaudeAdapter({
      claudeExecutablePath: '/test-only/claude',
      query: (params) =>
        query({
          ...params,
          options: {
            ...params.options,
            spawnClaudeCodeProcess: (options) => {
              spawned = options;
              child = spawnStandIn(options, [
                'SWITCH_MCP_SWITCH_AUTHORIZATION',
                'SWITCH_MCP_ATLASSIAN_AUTHORIZATION',
              ]);
              return child;
            },
          },
        }),
    });
    await adapter.startSession({
      sessionId: 'session-argv',
      cwd: process.cwd(),
      runtimeMode: 'approval-required',
      env: { PATH: process.env.PATH ?? '', HOME: '/tmp/test-only-claude-home' },
      mcpServers: {
        switch: {
          transport: 'http',
          url: 'http://127.0.0.1:4567/mcp',
          headers: { Authorization: switchBearer },
        },
        atlassian: {
          transport: 'http',
          url: 'http://127.0.0.1:4568/mcp',
          headers: { Authorization: connectorBearer },
        },
      },
      connectorMcpServers: ['atlassian'],
    });
    const exited = new Promise<number | null>((resolve) =>
      child!.once('exit', (code) => resolve(code))
    );

    try {
      const processOptions = spawned!;
      const argv = [processOptions.command, ...processOptions.args].join('\0');
      expect(argv).not.toContain('test-only-switch-session-bearer');
      expect(argv).not.toContain('test-only-connector-bearer');
      expect(processOptions.env.SWITCH_MCP_SWITCH_AUTHORIZATION).toBe(switchBearer);
      expect(processOptions.env.SWITCH_MCP_ATLASSIAN_AUTHORIZATION).toBe(connectorBearer);
      const config = JSON.parse(
        processOptions.args[processOptions.args.indexOf('--mcp-config') + 1]!
      ) as { mcpServers: Record<string, { headers?: Record<string, string> }> };
      expect(config.mcpServers.switch?.headers).toEqual({
        Authorization: '${SWITCH_MCP_SWITCH_AUTHORIZATION}',
      });
      expect(config.mcpServers.atlassian?.headers).toEqual({
        Authorization: '${SWITCH_MCP_ATLASSIAN_AUTHORIZATION}',
      });
    } finally {
      await adapter.stopAll();
    }
    expect(await exited).not.toBe(2);
  });
});

describe('claudeMcpLaunch', () => {
  it('gives every header and environment value a variable of its own', () => {
    const launch = claudeMcpLaunch(
      {
        'a-b': {
          transport: 'http',
          url: 'http://127.0.0.1:1/mcp',
          headers: { Authorization: 'Bearer secret-one', 'X-Api-Key': 'secret-two' },
        },
        a_b: {
          transport: 'http',
          url: 'http://127.0.0.1:2/mcp',
          headers: { authorization: 'secret-three' },
        },
        tool: {
          transport: 'stdio',
          command: 'node',
          args: ['tool.mjs'],
          env: { TOOL_TOKEN: 'secret-four' },
          envVars: ['SWITCH_API_TOKEN', 'ABSENT'],
        },
      },
      { SWITCH_API_TOKEN: 'secret-five', SWITCH_MCP_TOOL_TOOL_TOKEN: 'already set' }
    );
    expect(launch.mcpServers).toEqual({
      'a-b': {
        type: 'http',
        url: 'http://127.0.0.1:1/mcp',
        headers: {
          Authorization: '${SWITCH_MCP_A_B_AUTHORIZATION}',
          'X-Api-Key': '${SWITCH_MCP_A_B_X_API_KEY}',
        },
      },
      a_b: {
        type: 'http',
        url: 'http://127.0.0.1:2/mcp',
        headers: { authorization: '${SWITCH_MCP_A_B_AUTHORIZATION_2}' },
      },
      tool: {
        type: 'stdio',
        command: 'node',
        args: ['tool.mjs'],
        env: {
          SWITCH_API_TOKEN: '${SWITCH_API_TOKEN}',
          TOOL_TOKEN: '${SWITCH_MCP_TOOL_TOOL_TOKEN_2}',
        },
      },
    });
    expect(launch.env).toEqual({
      SWITCH_API_TOKEN: 'secret-five',
      SWITCH_MCP_TOOL_TOOL_TOKEN: 'already set',
      SWITCH_MCP_A_B_AUTHORIZATION: 'Bearer secret-one',
      SWITCH_MCP_A_B_X_API_KEY: 'secret-two',
      SWITCH_MCP_A_B_AUTHORIZATION_2: 'secret-three',
      SWITCH_MCP_TOOL_TOOL_TOKEN_2: 'secret-four',
    });
    expect(JSON.stringify(launch.mcpServers)).not.toContain('secret-');
  });
});
