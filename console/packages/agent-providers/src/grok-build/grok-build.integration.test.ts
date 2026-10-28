import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createGrokBuildAdapter } from './grok-build-acp';

describeConformance('grok-build', {
  createAdapter: async () => createGrokBuildAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('grok', ['--version'], { encoding: 'utf8' });
    return probe.error || probe.status !== 0 ? 'the grok binary is not on PATH' : null;
  },
  skip: {
    'user-input': 'grok-build-acp user-input support not yet verified.',
    'steer-mid-turn': 'grok-build-acp steering support not yet verified.',
    subagent: 'grok-build-acp subagent support not yet verified.',
  },
  mcpServers: { echo: echoMcpServerSpec() },
  ...(process.env.XAI_API_KEY ? { env: { XAI_API_KEY: process.env.XAI_API_KEY } } : {}),
});
