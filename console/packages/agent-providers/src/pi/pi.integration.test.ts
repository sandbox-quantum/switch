import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createPiAdapter } from './pi-adapter';

/**
 * Provider keys Pi reads, passed through so the suite can sign in with one
 * from the shell, and on Windows what Node needs to run at all.
 */
const KEYS = [
  ...(process.platform === 'win32'
    ? ['SystemRoot', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'PATHEXT', 'COMSPEC']
    : []),
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
  'PI_CODING_AGENT_DIR',
];

describeConformance('pi', {
  createAdapter: async () => createPiAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('pi', ['--version'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    return probe.error || probe.status !== 0 ? 'the Pi CLI is not on PATH' : null;
  },
  skip: {
    'user-input': 'Pi has no question tool of its own (Pi 1.5.0, 2026-11-05).',
    subagent: 'Pi has no subagents of its own (Pi 1.5.0, 2026-11-05).',
  },
  // `PI_TEST_MODEL=groq/openai/gpt-oss-120b`, say; Pi's own default otherwise.
  ...(process.env.PI_TEST_MODEL ? { model: { id: process.env.PI_TEST_MODEL } } : {}),
  mcpServers: { echo: echoMcpServerSpec() },
  // The harness hands the CLI a minimal environment, so a key in the shell
  // would not reach it and Pi would have no model to use.
  env: Object.fromEntries(
    KEYS.filter((key) => process.env[key]).map((key) => [key, process.env[key]!])
  ),
});
