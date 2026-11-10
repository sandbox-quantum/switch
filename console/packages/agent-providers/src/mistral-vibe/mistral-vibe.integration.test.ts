import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createMistralVibeAdapter } from './mistral-vibe-adapter';

describeConformance('mistral-vibe', {
  createAdapter: async () => createMistralVibeAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('vibe-acp', ['--version'], { encoding: 'utf8' });
    return probe.error || probe.status !== 0
      ? 'the vibe-acp binary is not on PATH'
      : null;
  },
  mcpServers: { echo: echoMcpServerSpec() },
  // The harness hands the CLI a minimal environment; pass a key when set so
  // vibe-acp does not fall back to a browser sign-in that the harness cannot
  // finish.
  ...(process.env.MISTRAL_API_KEY
    ? { env: { MISTRAL_API_KEY: process.env.MISTRAL_API_KEY } }
    : {}),
});

