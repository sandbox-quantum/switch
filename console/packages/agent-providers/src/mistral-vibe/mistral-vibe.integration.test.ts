import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createMistralVibeAdapter } from './mistral-vibe-adapter';

describeConformance('mistral-vibe', {
  createAdapter: async () => createMistralVibeAdapter(),
  unavailableReason: async () => {
    const probeAcp = spawnSync('vibe-acp', ['--version'], { encoding: 'utf8', timeout: 5000 });
    const probeVibe = spawnSync('vibe', ['--version'], { encoding: 'utf8', timeout: 5000 });
    if ((probeAcp.error || probeAcp.status !== 0) && (probeVibe.error || probeVibe.status !== 0)) {
      return 'neither vibe-acp nor vibe binary is on PATH';
    }
    if (!process.env.MISTRAL_API_KEY) {
      return 'MISTRAL_API_KEY is not set';
    }
    return null;
  },
  mcpServers: { echo: echoMcpServerSpec() },
  ...(process.env.MISTRAL_API_KEY ? { env: { MISTRAL_API_KEY: process.env.MISTRAL_API_KEY } } : {}),
});
