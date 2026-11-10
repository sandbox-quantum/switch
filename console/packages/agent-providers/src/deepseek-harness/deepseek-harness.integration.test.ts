import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createDeepseekHarnessAdapter } from './deepseek-harness-acp';

describeConformance('deepseek-harness', {
  createAdapter: async () => createDeepseekHarnessAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('dsh', ['--version'], { encoding: 'utf8' });
    return probe.error || probe.status !== 0 ? 'the dsh binary is not on PATH' : null;
  },
  skip: {
    'user-input': 'dsh --profile acp does not expose interactive user input tools over ACP.',
    'steer-mid-turn':
      'dsh --profile acp does not support steering a turn mid-execution; turns are queued sequentially.',
    subagent:
      'dsh --profile acp runs subagents out-of-process without emitting subagent task items over ACP.',
  },
  mcpServers: { echo: echoMcpServerSpec() },
  ...(process.env.DEEPSEEK_API_KEY
    ? { env: { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY } }
    : {}),
});
