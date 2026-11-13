import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { ProviderSessionStartInput } from '../adapter';
import { describeConformance, echoMcpServerSpec, EventRecorder } from '../testing/index';
import { createOpenhandsAdapter, openhandsConversation, openhandsModel } from './openhands-acp';

// OpenHands' settings may leave the API key to the model provider's own
// variable, which Switch's session hosts pass through as well.
const env: Record<string, string> = Object.fromEntries(
  [
    'OPENHANDS_PERSISTENCE_DIR',
    'MISTRAL_API_KEY',
    'GEMINI_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
  ].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : []))
);
const settingsModel = await openhandsModel(env);
// Asked once, here: a cold `openhands --version` can take longer than a hook may.
const probe = spawnSync('openhands', ['--version'], { encoding: 'utf8' });
const unavailable =
  probe.error || probe.status !== 0
    ? 'the openhands binary is not on PATH'
    : settingsModel
      ? null
      : 'OpenHands has no model set up; choose one in its settings first';
const unavailableReason = async () => unavailable;

describeConformance('openhands', {
  createAdapter: async () => createOpenhandsAdapter(),
  unavailableReason,
  // OpenHands retries a rate-limited model call with up to a minute of backoff.
  timeoutMs: 300_000,
  skip: {
    'user-input':
      'OpenHands CLI 1.16.0 asks nothing over ACP but permission: it has no question tool (2026-11-05).',
  },
  mcpServers: { echo: echoMcpServerSpec() },
  // Every scenario asks for the model in OpenHands' settings, the one it lists.
  ...(settingsModel ? { model: { id: settingsModel } } : {}),
  env,
});

/** A session outside the conformance suite, with the environment it gives one. */
async function session(
  id: string,
  input: Partial<ProviderSessionStartInput>,
  run: (
    adapter: ReturnType<typeof createOpenhandsAdapter>,
    recorder: EventRecorder
  ) => Promise<void>
): Promise<void> {
  const adapter = createOpenhandsAdapter();
  const recorder = new EventRecorder(adapter);
  const cwd = await mkdtemp(join(tmpdir(), 'switch-openhands-'));
  const sessionEnv = Object.fromEntries(
    ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'TERM'].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]]
    )
  ) as Record<string, string>;
  try {
    await adapter.startSession({
      sessionId: id,
      cwd,
      runtimeMode: 'full-access',
      env: { ...sessionEnv, ...env },
      mcpServers: {},
      connectorMcpServers: [],
      ...input,
    });
    await run(adapter, recorder);
  } finally {
    recorder.dispose();
    await adapter.stopAll();
    await rm(cwd, { recursive: true, force: true });
  }
}

async function ready(
  adapter: ReturnType<typeof createOpenhandsAdapter>,
  recorder: EventRecorder,
  sessionId: string
): Promise<void> {
  const turnId = `${sessionId}-turn`;
  await adapter.sendTurn({
    sessionId,
    turnId,
    text: 'Reply with exactly the word READY and nothing else. Do not use any tools.',
  });
  const done = await recorder.waitFor('turn.completed', (e) => e.turnId === turnId, 300_000);
  expect(done.outcome).toBe('completed');
  expect(recorder.assistantText(turnId)).toContain('READY');
}

// Its ACP server reads lines of at most 64 KiB, and Switch's context is longer.
it('answers a first turn whose system context is longer than the line OpenHands reads', async (ctx) => {
  const reason = await unavailableReason();
  if (reason) return ctx.skip(`openhands unavailable: ${reason}`);
  await session(
    'long-context',
    {
      systemContext: 'Background note for this session; nothing in it needs doing.\n'.repeat(1200),
    },
    async (adapter, recorder) => await ready(adapter, recorder, 'long-context')
  );
}, 300_000);

// It accepts `session/set_model` and changes nothing, so its own record of the
// conversation is what says which model answered.
it('runs a turn on the model set in OpenHands, the only one it lists, and refuses another', async (ctx) => {
  const reason = await unavailableReason();
  if (reason) return ctx.skip(`openhands unavailable: ${reason}`);
  await expect(
    session('other-model', { model: { id: 'openai/not-the-settings-model' } }, async () => {})
  ).rejects.toThrow(`runs ${settingsModel}, the model set in its own settings`);
  await session('settings-model', { model: { id: settingsModel! } }, async (adapter, recorder) => {
    expect((await adapter.listModels('settings-model')).map((model) => model.id)).toEqual([
      settingsModel,
    ]);
    await ready(adapter, recorder, 'settings-model');
    const started = recorder.ofType('session.started')[0];
    if (!started) throw new Error('The session never started.');
    const record = JSON.parse(
      await readFile(
        join(openhandsConversation(env, started.nativeSessionId), 'base_state.json'),
        'utf8'
      )
    ) as { stats: { usage_to_metrics: { agent: { token_usages: Array<{ model: string }> } } } };
    const calls = record.stats.usage_to_metrics.agent.token_usages.map((usage) => usage.model);
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls)).toEqual(new Set([settingsModel]));
  });
}, 300_000);
