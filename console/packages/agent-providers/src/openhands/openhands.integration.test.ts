import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createOpenhandsAdapter } from './openhands-adapter';

describeConformance('openhands', {
  createAdapter: async () => createOpenhandsAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('openhands', ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (probe.error || probe.status !== 0) {
      return 'the openhands binary is not on PATH';
    }
    if (!process.env.OPENHANDS_API_KEY && !process.env.ALL_HANDS_API_KEY && !process.env.LLM_API_KEY) {
      return 'OPENHANDS_API_KEY is not set';
    }
    return null;
  },
  mcpServers: { echo: echoMcpServerSpec() },
  ...(process.env.OPENHANDS_API_KEY ? { env: { OPENHANDS_API_KEY: process.env.OPENHANDS_API_KEY } } : {}),
});
