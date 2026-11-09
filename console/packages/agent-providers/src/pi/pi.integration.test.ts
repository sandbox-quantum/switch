import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { describeConformance, echoMcpServerSpec, EventRecorder } from '../testing/index';
import { createPiAdapter } from './pi-adapter';
import { checkPiSignIn } from './sign-in';

const BINARY = process.env['SWITCH_PI_BIN'] ?? 'pi';
const MODEL = process.env['SWITCH_PI_MODEL'] ?? 'google/gemini-2.5-flash';
// The model a session is switched to mid-way, on the same provider.
const SECOND_MODEL = process.env['SWITCH_PI_SECOND_MODEL'] ?? 'google/gemini-2.5-flash-lite';
// Pi reads a provider key from the environment when `/login` stored none.
const ENV = Object.fromEntries(
  ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'USERPROFILE']
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name] as string])
);

async function unavailableReason(): Promise<string | null> {
  try {
    const signIn = await checkPiSignIn({
      binaryPath: BINARY,
      cwd: homedir(),
      env: process.env as Record<string, string>,
    });
    return signIn.status === 'authenticated' ? null : signIn.message;
  } catch (error) {
    return `\`${BINARY} --list-models\` failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

describeConformance('pi', {
  createAdapter: async () => createPiAdapter({ binaryPath: BINARY }),
  unavailableReason,
  model: { id: MODEL },
  env: ENV,
  mcpServers: { switch_echo: echoMcpServerSpec() },
  timeoutMs: 240_000,
  skip: {
    'user-input':
      'pi 1.4.0 has no tool that asks the user a question: its built-in tools are read, bash, edit, write, grep, find and ls, and RPC mode carries questions only from extensions. Checked 2026-10-28.',
    subagent:
      'pi 1.4.0 has no subagents: it runs one agent loop per session and ships no delegation tool. Checked 2026-10-28.',
  },
});

describe('pi with a model chosen in Switch', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.allSettled(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('runs each turn on the chosen model, and on the new one after a switch', async (ctx) => {
    const unavailable = await unavailableReason();
    if (unavailable) return ctx.skip(`pi unavailable: ${unavailable}`);
    const adapter = createPiAdapter({ binaryPath: BINARY });
    const recorder = new EventRecorder(adapter);
    const cwd = await mkdtemp(join(tmpdir(), 'switch-pi-model-'));
    dirs.push(cwd);
    const sessionId = `session-model-${Date.now().toString(36)}`;
    const env: Record<string, string> = { ...ENV };
    for (const key of ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'TERM']) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    try {
      await adapter.startSession({
        sessionId,
        cwd,
        runtimeMode: 'full-access',
        env,
        mcpServers: {},
        connectorMcpServers: [],
        model: { id: MODEL },
      });
      // Pi bills each model response to the model that answered it.
      const billed = async (turnId: string) => {
        await adapter.sendTurn({
          sessionId,
          turnId,
          text: 'Reply with the word ok. Use no tools.',
        });
        const done = await recorder.waitFor('turn.completed', (e) => e.turnId === turnId, 180_000);
        expect(done.outcome).toBe('completed');
        expect(done.usage.length).toBeGreaterThan(0);
        return [...new Set(done.usage.map((entry) => entry.model))];
      };
      expect(await billed('turn-first')).toEqual([MODEL]);
      await adapter.setModel!(sessionId, { id: SECOND_MODEL });
      expect(await billed('turn-second')).toEqual([SECOND_MODEL]);
    } finally {
      recorder.dispose();
      await adapter.stopAll();
    }
  }, 420_000);
});
