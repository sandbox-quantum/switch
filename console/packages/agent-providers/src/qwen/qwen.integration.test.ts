import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { acpInitialize } from '../acp/acp-adapter';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { StdioJsonRpcClient, noopLogger } from '../transport/stdio-json-rpc';
import { createQwenAdapter } from './qwen-adapter';

describe('Qwen ACP integration', () => {
  it('completes the ACP initialize handshake without authenticating', async () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    );

    const client = new StdioJsonRpcClient({
      command: 'qwen',
      args: ['--acp'],
      cwd: process.cwd(),
      env,
      logger: noopLogger,
      onExit: () => {},
    });

    try {
      const result = await acpInitialize(client);

      expect(result.agentInfo?.name).toBe('qwen-code');
      expect(result.agentCapabilities?.promptCapabilities?.image).toBe(true);
      expect(result.agentCapabilities?.sessionCapabilities?.resume).toBeDefined();
    } finally {
      await client.dispose();
    }
  }, 90_000);
});

describeConformance('qwen', {
  createAdapter: async () => createQwenAdapter(),

  unavailableReason: async () => {
    const isWindows = process.platform === 'win32';
    const probe = isWindows
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'qwen.cmd --version'], {
          encoding: 'utf8',
          windowsHide: true,
        })
      : spawnSync('qwen', ['--version'], {
          encoding: 'utf8',
          windowsHide: true,
        });

    if (probe.error || probe.status !== 0) {
      return 'the Qwen Code CLI binary is not available';
    }

    if (process.env.QWEN_CODE_INTEGRATION !== '1') {
      return 'authenticated Qwen conformance requires credentials; set QWEN_CODE_INTEGRATION=1 to opt in when signed in';
    }

    return null;
  },

  mcpServers: { echo: echoMcpServerSpec() },
});
