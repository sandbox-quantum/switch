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
    'user-input': 'dsh-acp user-input support not yet verified.',
    'steer-mid-turn': 'dsh-acp steering support not yet verified.',
    subagent: 'dsh-acp subagent support not yet verified.',
  },
  mcpServers: { echo: echoMcpServerSpec() },
  ...(process.env.DEEPSEEK_API_KEY ? { env: { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY } } : {}),
});
