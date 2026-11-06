import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { EXECUTION_INHERIT_ENV } from '../host/agent-env';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createPiAdapter } from './pi-adapter';
import { checkPiSignIn } from './sign-in';

const BINARY = process.env['SWITCH_PI_BIN'] ?? 'pi';
const MODEL = process.env['SWITCH_PI_MODEL'];

// The harness hands the CLI a minimal environment, so what signs Pi in has to
// be passed through: the API keys the host would, and where Pi keeps a /login.
const env = Object.fromEntries(
  EXECUTION_INHERIT_ENV.flatMap((key) => {
    const value = process.env[key];
    return value === undefined ? [] : [[key, value]];
  })
);

describeConformance('pi', {
  createAdapter: async () => createPiAdapter({ binaryPath: BINARY }),
  unavailableReason: async () => {
    const probe = spawnSync(BINARY, ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return `the Pi binary (${BINARY}) is not on PATH`;
    const readiness = await checkPiSignIn({ binaryPath: BINARY, cwd: tmpdir(), env });
    return readiness.status === 'authenticated' ? null : readiness.message;
  },
  ...(MODEL ? { model: { id: MODEL } } : {}),
  env,
  skip: {
    subagent:
      'Pi 1.5.0 has no built-in subagent tool: its README leaves sub-agents to extensions (2026-11-05).',
  },
  mcpServers: { echo: echoMcpServerSpec() },
});
