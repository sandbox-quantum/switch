import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { checkAcpSignIn } from '../acp/acp-adapter';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createMistralVibeAdapter, mistralVibeAcp } from './mistral-vibe-acp';

// The harness hands the CLI a minimal environment, so a key or a Vibe home
// set in the shell would not reach it otherwise.
const env = Object.fromEntries(
  ['MISTRAL_API_KEY', 'VIBE_HOME'].flatMap((key) => {
    const value = process.env[key];
    return value ? [[key, value]] : [];
  })
);

describeConformance('mistral-vibe', {
  createAdapter: async () => createMistralVibeAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('vibe-acp', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the vibe-acp binary is not on PATH';
    const signIn = await checkAcpSignIn(mistralVibeAcp, {
      binaryPath: 'vibe-acp',
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? '', HOME: homedir(), ...env },
    });
    return signIn.status === 'authenticated' ? null : signIn.message;
  },
  mcpServers: { echo: echoMcpServerSpec() },
  env,
});
