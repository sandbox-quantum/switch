import { spawnSync } from 'node:child_process';
import { checkAcpSignIn } from '../acp/acp-adapter';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createFactoryDroidAdapter, factoryDroidAcp } from './factory-droid-acp';

// The harness hands the CLI a minimal environment, so a key in the shell would
// not reach it otherwise.
const env: Record<string, string> = process.env.FACTORY_API_KEY
  ? { FACTORY_API_KEY: process.env.FACTORY_API_KEY }
  : {};

describeConformance('factory-droid', {
  createAdapter: async () => createFactoryDroidAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('droid', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the droid binary is not on PATH';
    const signIn = await checkAcpSignIn(factoryDroidAcp, {
      binaryPath: 'droid',
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    });
    return signIn.status === 'authenticated'
      ? null
      : 'Factory Droid is not signed in (set FACTORY_API_KEY, or run droid and sign in)';
  },
  timeoutMs: 300_000,
  mcpServers: { echo: echoMcpServerSpec() },
  env,
});
