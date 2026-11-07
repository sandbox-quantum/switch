import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createGrokBuildAdapter } from './grok-build-acp';

describeConformance('grok-build', {
  createAdapter: async () => createGrokBuildAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('grok', ['--version'], { encoding: 'utf8' });
    return probe.error || probe.status !== 0 ? 'the grok binary is not on PATH' : null;
  },
  mcpServers: { echo: echoMcpServerSpec() },
  ...(process.env.XAI_API_KEY ? { env: { XAI_API_KEY: process.env.XAI_API_KEY } } : {}),
  skip: {
    'user-input': 'Grok Build ACP user-input support is not verified yet.',
    'steer-mid-turn': 'Grok Build ACP steering support is not verified yet.',
    subagent: 'Grok Build ACP subagent support is not verified yet.',
  },
});
