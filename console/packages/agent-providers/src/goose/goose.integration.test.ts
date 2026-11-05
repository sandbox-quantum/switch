import { spawnSync } from 'node:child_process';
import { checkAcpSignIn } from '../acp/acp-adapter';
import { EXECUTION_INHERIT_ENV } from '../host/agent-env';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createGooseAdapter, gooseAcp } from './goose-acp';

const allowed = new Set(EXECUTION_INHERIT_ENV.map((key) => key.toUpperCase()));
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env))
  if (value !== undefined && allowed.has(key.toUpperCase())) env[key] = value;

describeConformance('goose', {
  createAdapter: async () => createGooseAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('goose', ['--version'], { encoding: 'utf8', timeout: 15000 });
    if (probe.error || probe.status !== 0) return 'the Goose binary is not on PATH';
    const result = await checkAcpSignIn(gooseAcp, { binaryPath: 'goose', cwd: process.cwd(), env });
    return result.status === 'authenticated' ? null : result.message;
  },
  env,
  ...(env.GOOSE_MODEL ? { model: { id: env.GOOSE_MODEL } } : {}),
  mcpServers: { echo: echoMcpServerSpec() },
  // Goose runs whatever model it is configured with, a local one included,
  // and a turn there can outlast the default deadline.
  timeoutMs: 600_000,
  skip: {
    'user-input':
      'Goose 1.57.0 asks questions only through ACP form elicitation, which the generic adapter does not advertise (2026-11-01).',
  },
});
