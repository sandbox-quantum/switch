import { spawnSync } from 'node:child_process';
import { checkAcpSignIn } from '../acp/acp-adapter';
import { EXECUTION_INHERIT_ENV } from '../host/agent-env';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createKimiAdapter, kimiAcp } from './kimi-acp';

// Kimi's own variables too, so a `KIMI_MODEL_*` key in the shell reaches it.
const allowed = new Set(
  [...EXECUTION_INHERIT_ENV, ...(kimiAcp.inheritEnv ?? [])].map((key) => key.toUpperCase())
);
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env))
  if (value !== undefined && allowed.has(key.toUpperCase())) env[key] = value;

describeConformance('kimi', {
  createAdapter: async () => createKimiAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('kimi', ['--version'], {
      encoding: 'utf8',
      timeout: 15000,
      shell: process.platform === 'win32',
    });
    if (probe.error || probe.status !== 0) return 'the kimi binary is not on PATH';
    const result = await checkAcpSignIn(kimiAcp, { binaryPath: 'kimi', cwd: process.cwd(), env });
    return result.status === 'authenticated' ? null : result.message;
  },
  env,
  mcpServers: { echo: echoMcpServerSpec() },
  // Kimi Code runs whatever model it is configured with, and a turn on a slow
  // or rate-limited one can outlast the default deadline.
  timeoutMs: 600_000,
});
