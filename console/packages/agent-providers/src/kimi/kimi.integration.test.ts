import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createKimiAdapter } from './kimi-acp';

// The harness hands the CLI a minimal environment, so pass through what Kimi
// reads to find its home or to sign in without one.
const env = Object.fromEntries(
  [
    'KIMI_CODE_HOME',
    'KIMI_MODEL_NAME',
    'KIMI_MODEL_API_KEY',
    'KIMI_MODEL_PROVIDER_TYPE',
    'KIMI_MODEL_BASE_URL',
  ]
    .map((name) => [name, process.env[name]] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
);

describeConformance('kimi', {
  createAdapter: async () =>
    createKimiAdapter(process.env.KIMI_BIN ? { binaryPath: process.env.KIMI_BIN } : {}),
  unavailableReason: async () => {
    const probe = spawnSync('kimi', ['--version'], { encoding: 'utf8' });
    return probe.error || probe.status !== 0 ? 'the kimi binary is not on PATH' : null;
  },
  mcpServers: { echo: echoMcpServerSpec() },
  ...(Object.keys(env).length > 0 ? { env } : {}),
});
