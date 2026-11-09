import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { checkKimiSignIn, createKimiAdapter, kimiAcp } from './kimi-acp';

// The harness hands the CLI a minimal environment, so pass through what Kimi
// reads to find its home or to sign in without one.
const env = Object.fromEntries(
  kimiAcp
    .inheritEnv!.map((name) => [name, process.env[name]] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
);

describeConformance('kimi', {
  createAdapter: async () =>
    createKimiAdapter(process.env.KIMI_BIN ? { binaryPath: process.env.KIMI_BIN } : {}),
  unavailableReason: async () => {
    const probe = spawnSync('kimi', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the kimi binary is not on PATH';
    return (await checkKimiSignIn(env)).status === 'authenticated'
      ? null
      : 'Kimi Code is not signed in (run kimi login)';
  },
  mcpServers: { echo: echoMcpServerSpec() },
  ...(Object.keys(env).length > 0 ? { env } : {}),
});
