import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createAntigravityAdapter } from './antigravity-adapter';

const SIGN_IN_VARIABLES = [
  'GEMINI_API_KEY',
  'AGY_ADC_AUTH',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_QUOTA_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_APPLICATION_CREDENTIALS',
];

describeConformance('antigravity', {
  createAdapter: async () => createAntigravityAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('agy', ['--version'], { encoding: 'utf8' });
    return probe.error || probe.status !== 0 ? 'the agy binary is not on PATH' : null;
  },
  // `invoke_subagent` runs a whole nested conversation, which can outlast the
  // default deadline on a slow day.
  timeoutMs: 300_000,
  skip: {
    subagent:
      'Neither antigravity-acp 1.1.1 (2026-10-11) nor agy 1.5.1 (2026-11-05) finishes a subagent within the 300 s deadline.',
  },
  mcpServers: { echo: echoMcpServerSpec() },
  // agy signs itself in from the user's keychain; a key in the environment, or
  // Vertex AI application-default credentials, is how a machine without one
  // runs the suite.
  env: Object.fromEntries(
    SIGN_IN_VARIABLES.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : []))
  ),
});
