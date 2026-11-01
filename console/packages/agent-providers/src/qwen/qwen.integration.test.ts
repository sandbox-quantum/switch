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
  mcpServers: { echo: echoMcpServerSpec() },
});
