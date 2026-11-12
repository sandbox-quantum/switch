import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderRuntimeEvent } from '../events';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createPiAdapter } from './pi-adapter';
import { checkPiSignIn, PI_INHERIT_ENV } from './sign-in';

const BINARY = process.env.SWITCH_PI_BIN ?? 'pi';
const MODEL = process.env.SWITCH_PI_MODEL;
const SECOND_MODEL = process.env.SWITCH_PI_SECOND_MODEL;
const TIMEOUT_MS = 300_000;

// The harness hands the CLI a minimal environment, so the API keys Pi signs
// in with are passed through from the shell.
const env: Record<string, string> = {};
for (const [name, value] of Object.entries(process.env))
  if (value && (name.endsWith('_API_KEY') || (PI_INHERIT_ENV as readonly string[]).includes(name)))
    env[name] = value;
const baseEnv = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env };

async function unavailableReason(): Promise<string | null> {
  const signedIn = await checkPiSignIn({ binaryPath: BINARY, cwd: process.cwd(), env: baseEnv });
  return signedIn.status === 'authenticated' ? null : `${BINARY}: ${signedIn.message}`;
}

describeConformance('pi', {
  createAdapter: async () => createPiAdapter({ binaryPath: BINARY }),
  unavailableReason,
  ...(MODEL ? { model: { id: MODEL } } : {}),
  // Free model tiers answer 429 often, and Pi retries with backoff.
  timeoutMs: TIMEOUT_MS,
  skip: {
    'user-input':
      'Pi 1.5.0 has no tool that asks the user: its question tool is an example extension (examples/extensions/question.ts), which returns an error outside the TUI (2026-11-05).',
    subagent:
      'Pi 1.5.0 ships no subagent tool; delegation is an example extension (examples/extensions/subagent) (2026-11-05).',
  },
  mcpServers: { echo: echoMcpServerSpec() },
  env,
});

// Beyond the shared suite: Pi bills each turn to the model chosen in Switch,
// at the start and after a change mid-session (`SWITCH_PI_SECOND_MODEL`).
describe('pi with a model chosen in Switch', () => {
  it(
    'runs each turn on the chosen model',
    async (ctx) => {
      if (!MODEL) return ctx.skip('SWITCH_PI_MODEL is not set.');
      const unavailable = await unavailableReason();
      if (unavailable) return ctx.skip(unavailable);
      const adapter = createPiAdapter({ binaryPath: BINARY });
      const events: ProviderRuntimeEvent[] = [];
      adapter.subscribe((event) => events.push(event));
      const cwd = await mkdtemp(join(tmpdir(), 'switch-pi-model-'));
      const modelsOf = async (turnId: string) => {
        await adapter.sendTurn({
          sessionId: 'model',
          turnId,
          text: 'Reply with the single word ok. Do not use any tools.',
        });
        let done: Extract<ProviderRuntimeEvent, { type: 'turn.completed' }> | undefined;
        await vi.waitFor(
          () => {
            for (const event of events)
              if (event.type === 'turn.completed' && event.turnId === turnId) done = event;
            expect(done).toBeDefined();
          },
          { timeout: TIMEOUT_MS, interval: 250 }
        );
        expect(done!.outcome).toBe('completed');
        return done!.usage.map((usage) => usage.model);
      };
      try {
        await adapter.startSession({
          sessionId: 'model',
          cwd,
          runtimeMode: 'full-access',
          env: baseEnv,
          mcpServers: {},
          connectorMcpServers: [],
          model: { id: MODEL },
        });
        expect(await modelsOf('first')).toEqual([MODEL]);
        if (!SECOND_MODEL) return;
        await adapter.setModel('model', { id: SECOND_MODEL });
        expect(await modelsOf('second')).toEqual([SECOND_MODEL]);
      } finally {
        await adapter.stopAll();
        await rm(cwd, { recursive: true, force: true });
      }
    },
    2 * TIMEOUT_MS
  );
});
