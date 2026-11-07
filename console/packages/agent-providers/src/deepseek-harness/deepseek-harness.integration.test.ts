import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { checkDshSignIn, createDeepseekHarnessAdapter } from './deepseek-harness-acp';

// The harness hands the CLI a minimal environment, so a key or a dsh home in
// the shell would not reach it otherwise.
const env = Object.fromEntries(
  (['DEEPSEEK_API_KEY', 'DSH_HOME'] as const).flatMap((key) =>
    process.env[key] ? [[key, process.env[key]!]] : []
  )
);

describeConformance('deepseek-harness', {
  createAdapter: async () => createDeepseekHarnessAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('dsh', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the dsh binary is not on PATH';
    const signIn = await checkDshSignIn({
      cwd: process.cwd(),
      env: { HOME: process.env.HOME ?? '', ...env },
    });
    return signIn.status === 'authenticated'
      ? null
      : 'DeepSeek Harness has no DeepSeek API key (set DEEPSEEK_API_KEY, or save one with dsh web)';
  },
  skip: {
    'user-input':
      'dsh-acp is automation-only: it implements no elicitation or question extension, so a question can only come as prose.',
  },
  timeoutMs: 300_000,
  mcpServers: { echo: echoMcpServerSpec() },
  env,
});
