import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createMistralVibeAdapter } from './mistral-vibe-acp';

describeConformance('mistral-vibe', {
  createAdapter: async () => createMistralVibeAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('vibe', ['--version'], { encoding: 'utf8' });
    return probe.error || probe.status !== 0 ? 'the Mistral Vibe binary is not on PATH' : null;
  },
  mcpServers: { echo: echoMcpServerSpec() },
  ...(process.env.MISTRAL_API_KEY ? { env: { MISTRAL_API_KEY: process.env.MISTRAL_API_KEY } } : {}),
});
