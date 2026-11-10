import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createGrokAdapter } from './grok-acp';

describeConformance('grok', {
  createAdapter: async () => createGrokAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('grok', ['--version'], { encoding: 'utf8' });
    return probe.error || probe.status !== 0 ? 'the Grok binary is not on PATH' : null;
  },
  mcpServers: { echo: echoMcpServerSpec() },
  ...(process.env.XAI_API_KEY
    ? { env: { XAI_API_KEY: process.env.XAI_API_KEY } }
    : process.env.GROK_API_KEY
      ? { env: { GROK_API_KEY: process.env.GROK_API_KEY } }
      : {}),
});
