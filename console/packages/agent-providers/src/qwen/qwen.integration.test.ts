import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createQwenAdapter } from './qwen-adapter';

/** The OpenAI-compatible sign-in the run is given, as the agent's session would be. */
const openAiEnv = Object.fromEntries(
  ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'].flatMap((key) =>
    process.env[key] ? [[key, process.env[key]!]] : []
  )
);

describeConformance('qwen', {
  createAdapter: async () => createQwenAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('qwen', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the qwen binary is not on PATH';
    return process.env.OPENAI_API_KEY ? null : 'OPENAI_API_KEY is not set';
  },
  env: openAiEnv,
  skip: {
    subagent:
      'qwen-code 0.26.5 reaches its agent tool through tool_call and announces the call as tool_call before naming it, so the subagent is typed from its next update (item.updated), not at item.started as this check asks; the promotion is covered by qwen-adapter.test.ts (2026-11-01).',
  },
  mcpServers: { echo: echoMcpServerSpec() },
});
