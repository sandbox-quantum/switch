import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll } from 'vitest';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createPiAdapter } from './pi-adapter';
import { parsePiModelList } from './sign-in';

const SKIP = {
  'user-input':
    'Pi has no tool for asking the user a question (pi 1.4.0, 2026-10-29); an agent on Pi asks in the room with the Switch tools.',
  subagent: 'Pi has no subagents of its own; extensions add them (pi 1.4.0, 2026-10-29).',
};

/** The model provider keys Pi reads, passed through as the harness gives Pi a minimal environment. */
const KEYS = [
  'ANTHROPIC_API_KEY',
  'DEEPSEEK_API_KEY',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'XAI_API_KEY',
];

function piModels(env: NodeJS.ProcessEnv): string | null {
  const probe = spawnSync('pi', ['--list-models'], {
    encoding: 'utf8',
    env: { ...env, PI_OFFLINE: '1' },
  });
  if (probe.error || probe.status !== 0) return 'the pi binary is not on PATH';
  return parsePiModelList(probe.stdout).length ? null : 'no model provider is signed in to Pi';
}

// Against a real model: set PI_CONFORMANCE_MODEL (provider/model) to choose
// it, else Pi uses its default.
describeConformance('pi', {
  createAdapter: async () => createPiAdapter(),
  unavailableReason: async () => piModels(process.env),
  ...(process.env.PI_CONFORMANCE_MODEL ? { model: { id: process.env.PI_CONFORMANCE_MODEL } } : {}),
  skip: SKIP,
  mcpServers: { echo: echoMcpServerSpec() },
  env: Object.fromEntries(
    KEYS.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : []))
  ),
});

// Against real Pi with a scripted model (`fixtures/scripted-model.js`): no key
// and no tokens, so the adapter can be checked against each Pi release. Pi
// runs in a home of its own, away from the user's Pi configuration.
const scratch = mkdtempSync(join(tmpdir(), 'pi-scripted-'));
const scriptedPi = join(scratch, 'pi');
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
describeConformance('pi with a scripted model', {
  createAdapter: async () => createPiAdapter({ binaryPath: scriptedPi }),
  unavailableReason: async () => {
    if (process.platform === 'win32') return 'the scripted run starts Pi through a shell script';
    const probe = spawnSync('pi', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the pi binary is not on PATH';
    const fixture = fileURLToPath(new URL('./fixtures/scripted-model.js', import.meta.url));
    writeFileSync(scriptedPi, `#!/bin/sh\nexec pi -e '${fixture}' "$@"\n`);
    chmodSync(scriptedPi, 0o755);
    return null;
  },
  model: { id: 'scripted/conformance' },
  timeoutMs: 60_000,
  skip: SKIP,
  mcpServers: { echo: echoMcpServerSpec() },
  env: { HOME: scratch },
});
