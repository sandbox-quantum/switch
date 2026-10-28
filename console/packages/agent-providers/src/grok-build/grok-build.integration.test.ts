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
    'user-input': 'Grok Build ACP does not expose an interactive ask-the-user tool over stdio.',
    'steer-mid-turn': 'Grok Build ACP queues subsequent messages rather than steering the running turn.',
    subagent: 'Grok Build ACP does not declare a subagent delegation tool over stdio.',
  },
  mcpServers: { echo: echoMcpServerSpec() },
  ...(process.env.XAI_API_KEY ? { env: { XAI_API_KEY: process.env.XAI_API_KEY } } : {}),
});
