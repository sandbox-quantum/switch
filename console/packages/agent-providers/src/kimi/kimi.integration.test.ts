import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderRuntimeEvent } from '../events';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createKimiAdapter, kimiHome } from './kimi-acp';

const MODEL = process.env.SWITCH_KIMI_MODEL;
const SECOND_MODEL = process.env.SWITCH_KIMI_SECOND_MODEL;
const TIMEOUT_MS = 180_000;

// Kimi reads keys from its config file, so a signed-in `kimi` needs no key
// here. KIMI_CODE_HOME and a KIMI_MODEL_* model are passed through when set,
// since the harness hands the CLI a minimal environment.
const passThrough = [
  'KIMI_CODE_HOME',
  'KIMI_MODEL_NAME',
  'KIMI_MODEL_API_KEY',
  'KIMI_MODEL_PROVIDER_TYPE',
  'KIMI_MODEL_BASE_URL',
].filter((key) => process.env[key]);
const env = Object.fromEntries(passThrough.map((key) => [key, process.env[key]!]));

function unavailable(): string | null {
  const probe = spawnSync('kimi', ['--version'], { encoding: 'utf8' });
  return probe.error || probe.status !== 0 ? 'the kimi binary is not on PATH' : null;
}

describeConformance('kimi', {
  createAdapter: async () => createKimiAdapter(),
  unavailableReason: async () => unavailable(),
  ...(MODEL ? { model: { id: MODEL } } : {}),
  mcpServers: { echo: echoMcpServerSpec() },
  ...(passThrough.length ? { env } : {}),
});

/** The model of every request Kimi sent for a session, from the session's own log. */
async function modelsUsed(nativeSessionId: string): Promise<string[]> {
  const sessions = join(kimiHome({ ...env, HOME: process.env.HOME ?? '' }), 'sessions');
  for (const dir of await readdir(sessions)) {
    const log = await readFile(
      join(sessions, dir, nativeSessionId, 'logs', 'kimi-code.log'),
      'utf8'
    ).catch(() => null);
    if (log !== null)
      return [...log.matchAll(/\bllm config\b.*?\bmodelAlias=(\S+)/g)].map((match) => match[1]!);
  }
  return [];
}

// Beyond the shared suite: Kimi runs each turn on the model chosen in Switch,
// at the start and after a change mid-session (`SWITCH_KIMI_SECOND_MODEL`).
// Kimi logs the model of every request it sends (`llm config ...
// modelAlias=<id>`) in the session's own log, which is what this reads.
describe('kimi with a model chosen in Switch', () => {
  it(
    'runs each turn on the chosen model',
    async (ctx) => {
      if (!MODEL) return ctx.skip('SWITCH_KIMI_MODEL is not set.');
      const reason = unavailable();
      if (reason) return ctx.skip(reason);
      const adapter = createKimiAdapter();
      const events: ProviderRuntimeEvent[] = [];
      adapter.subscribe((event) => events.push(event));
      const cwd = await mkdtemp(join(tmpdir(), 'switch-kimi-model-'));
      const turn = async (turnId: string) => {
        await adapter.sendTurn({
          sessionId: 'model',
          turnId,
          text: 'Reply with the single word ok. Do not use any tools.',
        });
        await vi.waitFor(
          () => {
            const done = events.find(
              (event) => event.type === 'turn.completed' && event.turnId === turnId
            );
            expect(done).toMatchObject({ outcome: 'completed' });
          },
          { timeout: TIMEOUT_MS, interval: 250 }
        );
      };
      try {
        const { nativeSessionId } = await adapter.startSession({
          sessionId: 'model',
          cwd,
          runtimeMode: 'full-access',
          env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
          mcpServers: {},
          connectorMcpServers: [],
          model: { id: MODEL },
        });
        await turn('first');
        const first = await modelsUsed(nativeSessionId);
        expect(first.length).toBeGreaterThan(0);
        expect(new Set(first)).toEqual(new Set([MODEL]));
        if (!SECOND_MODEL) return;
        await adapter.setModel('model', { id: SECOND_MODEL });
        await turn('second');
        const second = (await modelsUsed(nativeSessionId)).slice(first.length);
        expect(second.length).toBeGreaterThan(0);
        expect(new Set(second)).toEqual(new Set([SECOND_MODEL]));
      } finally {
        await adapter.stopAll();
        await rm(cwd, { recursive: true, force: true });
      }
    },
    3 * TIMEOUT_MS
  );
});
