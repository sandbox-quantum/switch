import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createMistralVibeAdapter } from './mistral-vibe-adapter';

describeConformance('mistral-vibe', {
  createAdapter: async () => createMistralVibeAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('vibe-acp', ['--help'], { encoding: 'utf8' });
    return probe.error || probe.status !== 0 ? 'the vibe-acp binary is not on PATH' : null;
  },
  mcpServers: { echo: echoMcpServerSpec() },
  // The harness hands the CLI a minimal environment, so a key in the shell
  // would not reach it and Vibe would fall back to its interactive sign-in.
  ...(process.env.MISTRAL_API_KEY ? { env: { MISTRAL_API_KEY: process.env.MISTRAL_API_KEY } } : {}),
});
