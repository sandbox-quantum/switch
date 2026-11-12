import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createClineAdapter } from './cline-adapter';

/**
 * Passed through from the shell, since the harness hands the CLI a minimal
 * environment. Cline signs in with the sign-in it saved or with
 * `CLINE_API_KEY`; with that set, `CLINE_PROVIDER` and `CLINE_MODEL` pick
 * another provider, which reads its own key (`GROQ_API_KEY`, say). On
 * Windows, Node also needs the system variables to run at all.
 */
const KEYS = [
  ...(process.platform === 'win32'
    ? ['SystemRoot', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'PATHEXT', 'COMSPEC']
    : []),
  'CLINE_API_KEY',
  'CLINE_PROVIDER',
  'CLINE_MODEL',
  'CLINE_DIR',
  'CLINE_DATA_DIR',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
];

describeConformance('cline', {
  createAdapter: async () => createClineAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('cline', ['--version'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    return probe.error || probe.status !== 0 ? 'the Cline CLI is not on PATH' : null;
  },
  skip: {
    'user-input': "Cline's ACP mode gives the model no question tool (Cline 3.0.74, 2026-11-05).",
  },
  mcpServers: { echo: echoMcpServerSpec() },
  // `CLINE_TEST_MODEL=nvidia/nemotron-3.5-lightning:free`, say; Cline's own default otherwise.
  ...(process.env.CLINE_TEST_MODEL ? { model: { id: process.env.CLINE_TEST_MODEL } } : {}),
  env: Object.fromEntries(
    KEYS.filter((key) => process.env[key]).map((key) => [key, process.env[key]!])
  ),
});
