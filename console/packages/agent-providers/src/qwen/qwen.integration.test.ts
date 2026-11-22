import { spawnSync } from 'node:child_process';
import { checkAcpSignIn } from '../acp/acp-adapter';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createQwenAdapter, qwenAcp } from './qwen-acp';

/** Provider variables Qwen signs in with, passed on because the harness gives the CLI a minimal environment. */
const QWEN_ENV = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'DASHSCOPE_API_KEY',
  'BAILIAN_CODING_PLAN_API_KEY',
  ...(qwenAcp.inheritEnv ?? []),
];
const env = Object.fromEntries(
  QWEN_ENV.flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : []))
);

describeConformance('qwen', {
  createAdapter: async () => createQwenAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('qwen', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the qwen binary is not on PATH';
    const signIn = await checkAcpSignIn(qwenAcp, {
      binaryPath: 'qwen',
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    });
    return signIn.status === 'authenticated' ? null : `qwen is not signed in: ${signIn.message}`;
  },
  // The model ids depend on the provider Qwen is set up with, so the suite
  // uses the configured one unless QWEN_CONFORMANCE_MODEL names another.
  ...(process.env.QWEN_CONFORMANCE_MODEL
    ? { model: { id: process.env.QWEN_CONFORMANCE_MODEL } }
    : {}),
  mcpServers: { echo: echoMcpServerSpec() },
  env,
});
