import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { checkAcpSignIn } from '../acp/acp-adapter';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createKimiAdapter, kimiAcp } from './kimi-acp';

// The harness hands the CLI a minimal environment, so a data root or a
// `KIMI_MODEL_*` sign-in set in the shell is passed on explicitly.
const env = Object.fromEntries(
  (kimiAcp.inheritEnv ?? []).flatMap((key) => {
    const value = process.env[key];
    return value === undefined ? [] : [[key, value]];
  })
);

describeConformance('kimi', {
  createAdapter: async () => createKimiAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('kimi', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the kimi binary is not on PATH';
    const signIn = await checkAcpSignIn(kimiAcp, {
      binaryPath: 'kimi',
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    });
    return signIn.status === 'authenticated' ? null : `kimi is not signed in (${signIn.message})`;
  },
  ...(process.env.KIMI_CONFORMANCE_MODEL
    ? { model: { id: process.env.KIMI_CONFORMANCE_MODEL } }
    : {}),
  mcpServers: { echo: echoMcpServerSpec() },
  env,
});
