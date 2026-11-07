import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createAmpAdapter } from './amp-adapter';
import { checkAmpSignIn } from './sign-in';

// The harness hands the CLI a minimal environment, so an AMP_API_KEY in the
// shell (the only non-interactive sign-in Amp has) would not reach it.
const env: Record<string, string> = process.env.AMP_API_KEY
  ? { AMP_API_KEY: process.env.AMP_API_KEY }
  : {};

describeConformance('amp', {
  createAdapter: async () => createAmpAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('amp', ['version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the amp binary is not on PATH';
    const signIn = await checkAmpSignIn({
      binaryPath: 'amp',
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    });
    return signIn.status === 'authenticated'
      ? null
      : `amp is not signed in (${signIn.status}). ${signIn.message}`;
  },
  skip: {
    interrupt:
      'Amp’s stream-JSON prints each assistant message whole, so this scenario’s trigger (the turn’s first text) comes after the model has finished a text-only turn, and a cancel sent then has nothing left to stop: Amp reports the turn done. Interrupting a running tool was checked by hand against amp 0.0.1794110442 on 2026-11-08: a cancel through the plugin while `sleep 60` ran ended the turn as interrupted, and the next turn ran on the same thread.',
    'user-input':
      'Amp’s ask_user_choice tool has no one to answer it under amp -x: a plugin dialog (ctx.ui.confirm) throws without a UI, and the stream-JSON protocol carries no question. Amp CLI 0.0.1794110442 and its plugin docs, 2026-11-08.',
  },
  mcpServers: { echo: echoMcpServerSpec() },
  env,
});
