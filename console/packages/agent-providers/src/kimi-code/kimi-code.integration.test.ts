import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { checkAcpSignIn } from '../acp/acp-adapter';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createKimiCodeAdapter, kimiCodeAcp } from './kimi-code-acp';

// The harness hands the CLI a minimal environment, so a Kimi home or a
// `KIMI_MODEL_*` model set in the shell would not reach it otherwise.
const env = Object.fromEntries(
  (kimiCodeAcp.inheritEnv ?? []).flatMap((key) => {
    const value = process.env[key];
    return value ? [[key, value]] : [];
  })
);

describeConformance('kimi-code', {
  createAdapter: async () => createKimiCodeAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('kimi', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the kimi binary is not on PATH';
    const signIn = await checkAcpSignIn(kimiCodeAcp, {
      binaryPath: 'kimi',
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? '', HOME: homedir(), ...env },
    });
    return signIn.status === 'authenticated' ? null : signIn.message;
  },
  mcpServers: { echo: echoMcpServerSpec() },
  env,
});
