import { spawnSync } from 'node:child_process';
import { checkAcpSignIn } from '../acp/acp-adapter';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createMistralVibeAdapter, mistralVibeAcp } from './mistral-vibe-acp';

// The harness hands the CLI a minimal environment, so a key or a Vibe home in
// the shell would not reach it otherwise.
const env = Object.fromEntries(
  (['MISTRAL_API_KEY', 'VIBE_HOME'] as const).flatMap((key) =>
    process.env[key] ? [[key, process.env[key]!]] : []
  )
);

describeConformance('mistral-vibe', {
  createAdapter: async () => createMistralVibeAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('vibe-acp', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the vibe-acp binary is not on PATH';
    const signIn = await checkAcpSignIn(mistralVibeAcp, {
      binaryPath: 'vibe-acp',
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    });
    return signIn.status === 'authenticated'
      ? null
      : 'Mistral Vibe has no API key (set MISTRAL_API_KEY, or run vibe --setup)';
  },
  timeoutMs: 300_000,
  mcpServers: { echo: echoMcpServerSpec() },
  env,
});
