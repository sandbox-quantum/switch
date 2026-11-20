import { spawnSync } from 'node:child_process';
import { checkAcpSignIn } from '../acp/acp-adapter';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createJunieAdapter, junieAcp } from './junie-adapter';

// The harness hands the CLI a minimal environment, so Junie's own variables in
// the shell (JUNIE_API_KEY, JUNIE_LLM_PROVIDER, a BYOK key) would not reach it
// and Junie would wait for a sign-in it cannot complete, or pick a provider the
// account cannot use.
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined &&
      (['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'TERM'].includes(entry[0]) ||
        entry[0].startsWith('JUNIE_'))
  )
);

describeConformance('junie', {
  createAdapter: async () => createJunieAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('junie', ['--version', '--skip-update-check'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the junie binary is not on PATH';
    const signIn = await checkAcpSignIn(junieAcp, { binaryPath: 'junie', cwd: process.cwd(), env });
    return signIn.status === 'authenticated'
      ? null
      : `junie is not ready (${signIn.status}). ${signIn.message}`;
  },
  skip: {
    'user-input':
      'Junie asks its questions through ACP elicitation (elicitation/create), which the generic ACP adapter does not implement; Junie 3959.5, 2026-11-07.',
    'approval-declined':
      'Told it may not be allowed to run the command, Junie in Safe mode (Claude Sonnet 5) answers "declined" without attempting it, so no approval is ever raised to decline; declining itself is covered by approval-required and the unit tests. Junie 3959.5, 2026-11-07.',
  },
  mcpServers: { echo: echoMcpServerSpec() },
  env: Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('JUNIE_'))),
});
