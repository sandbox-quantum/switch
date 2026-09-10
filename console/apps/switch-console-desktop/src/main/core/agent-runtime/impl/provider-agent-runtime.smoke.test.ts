/**
 * A real OpenCode session, driven end to end through `ProviderAgentRuntime`.
 *
 * Not part of the merge gate: it spawns `opencode serve`, spends real tokens and
 * takes minutes. It exists because everything else here asserts a mapping, and a
 * mapping being right is not the same as the runtime working — this is the one
 * test that proves a turn, an approval and a stop actually happen.
 *
 *   SWITCH_SMOKE=1 pnpm exec vitest run --project node \
 *     src/main/core/agent-runtime/impl/provider-agent-runtime.smoke.test.ts
 *
 * Deliberately headless: no Electron, no window, no database beyond the two
 * lookups mocked below, so a failure here is the runtime's and not the app's.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/core/providers/agentEvents';
import type { TranscriptEntry, TranscriptUpdate } from '@shared/core/sessions/session-transcript';
import type { Session } from '@shared/core/sessions/sessions';

const RUN = process.env.SWITCH_SMOKE === '1';
const MODEL = process.env.SWITCH_SMOKE_MODEL ?? 'opencode/big-pickle';
const SESSION_ID = 'smoke-session-1';
const AGENT_ID = 'smoke-agent-1';

const agentEvents: AgentEvent[] = [];
const savedNativeIds: string[] = [];

// Everything the runtime reaches for that needs an app around it. Each is
// stubbed at its narrowest point, so what is exercised below is the runtime
// and the adapter rather than a rig.
vi.mock('@main/core/agents/getAgentById', () => ({
  getAgentById: vi.fn(async () => ({
    id: AGENT_ID,
    name: 'smoke',
    providerId: 'opencode',
    autoApprove: false,
    providerConfig: null,
  })),
}));
vi.mock('@main/core/agents/agent-launch-config', () => ({
  agentLaunchSpecialization: vi.fn(async () => ({ model: MODEL })),
}));
vi.mock('@main/core/switch-rooms/switch-notification-poller', () => ({
  switchNotificationPoller: { ensureForSession: vi.fn(async () => null), disconnect: vi.fn() },
}));
vi.mock('@main/core/switch-rooms/switch-room-service', () => ({
  switchRoomService: { clearSession: vi.fn() },
}));
vi.mock('@main/core/switch-rooms/provider-room-relay', () => ({
  providerRoomRelay: { onRequestOpened: vi.fn(), onRequestResolved: vi.fn(), unbind: vi.fn() },
}));
vi.mock('@main/core/sessions/operations/save-provider-session-id', () => ({
  saveNativeSessionId: vi.fn(async (_sessionId: string, nativeId: string) => {
    savedNativeIds.push(nativeId);
  }),
}));
vi.mock('@main/core/sessions/session-hooks', () => ({ sessionHooks: { _emit: vi.fn() } }));
vi.mock('@main/core/agent-hooks/notification', () => ({
  isAppFocused: () => true,
  maybeShowNotification: vi.fn(async () => {}),
}));
vi.mock('@main/core/agent-hooks/agent-hook-service', () => ({
  agentHookService: {
    emitAgentEvent: vi.fn((event: AgentEvent) => {
      agentEvents.push(event);
    }),
  },
}));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION_ID,
    agentId: AGENT_ID,
    providerId: 'opencode',
    title: 'smoke',
    shellId: 'system',
    status: 'in_progress',
    statusChangedAt: new Date().toISOString(),
    agentSessionId: SESSION_ID,
    isInitialSession: false,
    isPinned: false,
    runtime: 'provider',
    agentName: 'smoke',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Session;
}

describe.skipIf(!RUN)('ProviderAgentRuntime against a real OpenCode', () => {
  let cwd: string;

  beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'switch-provider-smoke-'));
    await writeFile(join(cwd, 'README.md'), '# smoke\n\nA scratch directory.\n');
  });

  afterAll(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  it(
    'runs a turn, asks for permission, is answered, and stops',
    { timeout: 10 * 60_000 },
    async () => {
      const { ProviderAgentRuntime } = await import('./provider-agent-runtime');
      const runtime = new ProviderAgentRuntime({
        locationId: 'smoke-location',
        sessionId: SESSION_ID,
        sessionPath: cwd,
        sessionEnvVars: {},
      });

      const updates: TranscriptUpdate[] = [];
      runtime.subscribe((update) => updates.push(update));

      await runtime.start(session());
      expect(savedNativeIds).toHaveLength(1);

      // A plain turn: the transcript must carry the question and an answer.
      await runtime.sendTurn('Reply with exactly the word: pickle', 'console');
      await waitFor(() => turnFinished(runtime), 5 * 60_000);

      const entries = runtime.getTranscript().entries;
      expect(entries.some((e) => e.kind === 'user' && e.source === 'console')).toBe(true);
      expect(assistantText(entries).toLowerCase()).toContain('pickle');
      // The reply reaches the renderer as an entry that later `delta`s append
      // to. A short answer can arrive in one chunk, so only the entry is
      // guaranteed — asserting a `delta` would fail on a one-word reply.
      expect(updates.some((u) => u.type === 'entry' && u.entry.kind === 'assistant')).toBe(true);

      // Status, as the sidebar and the room read it.
      expect(agentEvents.map((e) => e.type)).toContain('start');
      expect(agentEvents.map((e) => e.type)).toContain('stop');

      // An approval, because the session runs in approval-required mode: a
      // shell command is exactly what OpenCode asks about.
      await runtime.sendTurn('Run the shell command `echo switch-smoke-ok`.', 'console');
      const requestId = await waitFor(() => openRequestId(runtime), 5 * 60_000);
      expect(agentEvents.some((e) => e.payload.notificationType === 'permission_prompt')).toBe(
        true
      );

      await runtime.respondToRequest(requestId, 'accept', 'console');
      await waitFor(() => resolvedRequest(runtime, requestId), 5 * 60_000);
      await waitFor(() => turnFinished(runtime), 5 * 60_000);

      expect(
        runtime
          .getTranscript()
          .entries.some((e) => e.kind === 'item' && e.item.type === 'command_execution')
      ).toBe(true);

      await runtime.stop();
      expect(runtime.getTranscript().state).toBe('stopped');
    }
  );
});

function assistantText(entries: TranscriptEntry[]): string {
  return entries
    .filter((entry) => entry.kind === 'assistant')
    .map((entry) => (entry.kind === 'assistant' ? entry.text : ''))
    .join('\n');
}

function turnFinished(runtime: {
  getTranscript: () => { turns: Array<{ status: string }> };
}): true | null {
  const turns = runtime.getTranscript().turns;
  const last = turns[turns.length - 1];
  return last && last.status !== 'running' ? true : null;
}

function openRequestId(runtime: {
  getTranscript: () => { pendingInputIds: string[] };
}): string | null {
  return runtime.getTranscript().pendingInputIds[0] ?? null;
}

function resolvedRequest(
  runtime: { getTranscript: () => { pendingInputIds: string[] } },
  requestId: string
): true | null {
  return runtime.getTranscript().pendingInputIds.includes(requestId) ? null : true;
}

/** Poll until `probe` returns something, or fail saying what never happened. */
async function waitFor<T>(probe: () => T | null, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`smoke: condition never held within ${timeoutMs}ms`);
}
