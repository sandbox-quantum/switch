import { spawnSync } from 'node:child_process';
import { checkAcpSignIn } from '../acp/acp-adapter';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { auggieAcp, createAuggieAdapter } from './auggie-acp';

// The harness hands the CLI a minimal environment, so a session in the shell
// would not reach it otherwise.
const env: Record<string, string> = process.env.AUGMENT_SESSION_AUTH
  ? { AUGMENT_SESSION_AUTH: process.env.AUGMENT_SESSION_AUTH }
  : {};

describeConformance('auggie', {
  createAdapter: async () => createAuggieAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('auggie', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the auggie binary is not on PATH';
    const signIn = await checkAcpSignIn(auggieAcp, {
      binaryPath: 'auggie',
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    });
    return signIn.status === 'authenticated'
      ? null
      : 'Auggie is not signed in (run auggie login, or set AUGMENT_SESSION_AUTH)';
  },
  timeoutMs: 300_000,
  skip: {
    'user-input':
      'Auggie 0.37 sends no question request over ACP: no elicitation and no vendor method',
  },
  mcpServers: { echo: echoMcpServerSpec() },
  env,
});
