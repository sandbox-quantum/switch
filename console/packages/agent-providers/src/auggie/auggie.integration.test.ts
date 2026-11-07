import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createAuggieAdapter } from './auggie-acp';

// The harness hands the CLI a minimal environment, so a session in the shell
// would not reach it and Auggie would refuse to start a session.
const session: Record<string, string> = process.env.AUGMENT_SESSION_AUTH
  ? { AUGMENT_SESSION_AUTH: process.env.AUGMENT_SESSION_AUTH }
  : {};

describeConformance('auggie', {
  createAdapter: async () => createAuggieAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('auggie', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the auggie binary is not on PATH';
    // Exits 0 only with a usable sign-in; its output is the session and is not read.
    const signedIn = spawnSync('auggie', ['token', 'print'], {
      encoding: 'utf8',
      env: { ...process.env, ...session, AUGMENT_DISABLE_AUTO_UPDATE: '1' },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return signedIn.status === 0 ? null : 'auggie is not signed in (run auggie login)';
  },
  mcpServers: { echo: echoMcpServerSpec() },
  ...(Object.keys(session).length ? { env: session } : {}),
});
