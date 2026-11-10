import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createAmpAdapter } from './amp-adapter';
import { checkAmpSignIn } from './sign-in';

// The harness hands the CLI a minimal environment, so a key in the shell would
// not reach it otherwise.
const env = process.env.AMP_API_KEY ? { AMP_API_KEY: process.env.AMP_API_KEY } : undefined;

describeConformance('amp', {
  createAdapter: async () => createAmpAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('amp', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the amp binary is not on PATH';
    const signIn = await checkAmpSignIn({
      binaryPath: 'amp',
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    });
    return signIn.status === 'authenticated'
      ? null
      : 'Amp is not signed in (set AMP_API_KEY to an access token, or run amp login)';
  },
  skip: {
    'user-input':
      'Amp stream JSON has no question channel (amp 0.0.1794009661, 2026-11-06): the adapter does not offer userInput, and Amp asks in prose.',
  },
  timeoutMs: 300_000,
  mcpServers: { echo: echoMcpServerSpec() },
  ...(env ? { env } : {}),
});
