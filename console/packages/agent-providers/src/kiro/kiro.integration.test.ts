import { spawnSync } from 'node:child_process';
import { checkAcpSignIn } from '../acp/acp-adapter';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createKiroAdapter, kiroAcp } from './kiro-acp';

// The harness hands the CLI a minimal environment, so an API key or a data
// directory in the shell would not reach it otherwise.
const env = Object.fromEntries(
  (['KIRO_API_KEY', 'XDG_DATA_HOME'] as const).flatMap((key) =>
    process.env[key] ? [[key, process.env[key]!]] : []
  )
);

describeConformance('kiro', {
  createAdapter: async () => createKiroAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('kiro-cli', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the kiro-cli binary is not on PATH';
    const signIn = await checkAcpSignIn(kiroAcp, {
      binaryPath: 'kiro-cli',
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    });
    return signIn.status === 'authenticated'
      ? null
      : 'Kiro CLI is not signed in (run kiro-cli login, or set KIRO_API_KEY)';
  },
  timeoutMs: 300_000,
  skip: {
    'user-input':
      'Kiro CLI 3.1.0 completed the ACP question prompt with ordinary text and no structured user-input request; this provider does not expose user input.',
  },
  mcpServers: { echo: echoMcpServerSpec() },
  env,
});
