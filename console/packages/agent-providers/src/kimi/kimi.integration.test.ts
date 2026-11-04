import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createKimiAdapter } from './kimi-acp';

// Kimi reads keys from its config file, so a signed-in `kimi` needs no key
// here. KIMI_CODE_HOME and a KIMI_MODEL_* model are passed through when set,
// since the harness hands the CLI a minimal environment.
const passThrough = [
  'KIMI_CODE_HOME',
  'KIMI_MODEL_NAME',
  'KIMI_MODEL_API_KEY',
  'KIMI_MODEL_PROVIDER_TYPE',
  'KIMI_MODEL_BASE_URL',
].filter((key) => process.env[key]);

describeConformance('kimi', {
  createAdapter: async () => createKimiAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('kimi', ['--version'], { encoding: 'utf8' });
    return probe.error || probe.status !== 0 ? 'the kimi binary is not on PATH' : null;
  },
  mcpServers: { echo: echoMcpServerSpec() },
  ...(passThrough.length
    ? { env: Object.fromEntries(passThrough.map((key) => [key, process.env[key]!])) }
    : {}),
});
