import { spawnSync } from 'node:child_process';
import { checkAcpSignIn } from '../acp/acp-adapter';
import { EXECUTION_INHERIT_ENV } from '../host/agent-env';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createGooseAdapter, gooseAcp } from './goose-acp';

const env = Object.fromEntries(
  EXECUTION_INHERIT_ENV.flatMap((key) => {
    const value = process.env[key];
    return value === undefined ? [] : [[key, value]];
  })
);

describeConformance('goose', {
  createAdapter: async () => createGooseAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('goose', ['--version'], { encoding: 'utf8', timeout: 15_000, env });
    if (probe.error || probe.status !== 0) return 'the goose binary is not available';
    const version = probe.stdout.trim();
    const status = await checkAcpSignIn(gooseAcp, { binaryPath: 'goose', cwd: process.cwd(), env });
    return status.status === 'authenticated'
      ? null
      : `Goose ${version}: ${status.message} (checked ${new Date().toISOString().slice(0, 10)})`;
  },
  timeoutMs: 300_000,
  skip: {
    'user-input':
      'Goose 1.43.0 uses ACP form elicitation, which the shared adapter does not advertise; Goose cancels those requests (2026-10-27).',
  },
  mcpServers: { echo: echoMcpServerSpec() },
  ...(env.GOOSE_MODEL ? { model: { id: env.GOOSE_MODEL } } : {}),
  env,
});
