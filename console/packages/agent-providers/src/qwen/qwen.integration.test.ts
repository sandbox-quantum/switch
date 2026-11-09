import { spawnSync } from 'node:child_process';
import { EXECUTION_INHERIT_ENV } from '../host/agent-env';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createQwenAdapter, qwenSignIn } from './qwen-acp';

const allowed = new Set(EXECUTION_INHERIT_ENV.map((key) => key.toUpperCase()));
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env))
  if (value !== undefined && allowed.has(key.toUpperCase())) env[key] = value;

describeConformance('qwen', {
  createAdapter: async () => createQwenAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('qwen', ['--version'], {
      encoding: 'utf8',
      timeout: 15000,
      shell: process.platform === 'win32',
    });
    if (probe.error || probe.status !== 0) return 'the qwen binary is not on PATH';
    const result = await qwenSignIn(env, process.cwd());
    return result.status === 'authenticated' ? null : result.message;
  },
  env,
  ...(env.OPENAI_MODEL ? { model: { id: env.OPENAI_MODEL } } : {}),
  mcpServers: { echo: echoMcpServerSpec() },
  // Qwen Code runs whatever model it is configured with, a local one included,
  // and a turn there can outlast the default deadline.
  timeoutMs: 600_000,
});
