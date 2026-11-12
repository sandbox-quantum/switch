import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { query, type SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { toMcpServerConfig } from './claude-mapping';

describe('Claude SDK process boundary', () => {
  it('keeps provider and MCP credentials in the child environment and out of argv', async () => {
    const providerKey = 'test-only-not-a-real-provider-key';
    const switchToken = 'test-only-not-a-real-switch-token';
    const env = {
      HOME: '/tmp/test-only-claude-home',
      ANTHROPIC_API_KEY: providerKey,
      SWITCH_API_TOKEN: switchToken,
    };
    const mcpServer = toMcpServerConfig(
      {
        transport: 'stdio',
        command: 'node',
        args: ['runtime.mjs'],
        envVars: ['SWITCH_API_TOKEN'],
      },
      env
    );

    let spawned: SpawnOptions | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;
    const running = query({
      prompt: (async function* () {})(),
      options: {
        env,
        mcpServers: { switch: mcpServer },
        pathToClaudeCodeExecutable: '/test-only/claude',
        spawnClaudeCodeProcess: (options) => {
          spawned = options;
          child = spawn(
            process.execPath,
            [
              '-e',
              'if (!process.env.ANTHROPIC_API_KEY || !process.env.SWITCH_API_TOKEN) process.exit(2); process.stdin.resume()',
            ],
            { env: options.env, stdio: 'pipe' }
          );
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
});
