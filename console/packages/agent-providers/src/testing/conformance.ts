import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type {
  McpServerSpec,
  ModelSelection,
  ProviderAdapter,
  ProviderSessionStartInput,
} from '../adapter';
import { EventRecorder } from './event-recorder';

export interface ConformanceOptions {
  /** Builds a fresh adapter. Called once per scenario so state cannot leak between them. */
  createAdapter: () => Promise<ProviderAdapter>;
  /** Skip the whole suite (binary missing, not logged in). Return the reason. */
  unavailableReason: () => Promise<string | null>;
  model?: ModelSelection;
  /** Per-scenario deadline; real providers on free tiers can be slow. */
  timeoutMs?: number;
  /**
   * An MCP server the agent can reach. The harness only checks the session
   * starts with it registered; adapters that cannot register one must set
   * `mcpServers: {}` and the scenario is skipped.
   */
  mcpServers?: Record<string, McpServerSpec>;
  /** Scenarios the provider genuinely cannot satisfy, with the reason. */
  skip?: Partial<Record<ConformanceScenario, string>>;
  /** Extra environment for spawned processes, layered over a minimal PATH/HOME. */
  env?: Record<string, string>;
}

export type ConformanceScenario =
  | 'simple-turn'
  | 'file-write-full-access'
  | 'approval-required'
  | 'approval-declined'
  | 'interrupt'
  | 'steer-mid-turn'
  | 'resume'
  | 'user-input'
  | 'subagent'
  | 'mcp-registered';

export const conformanceScenarios: ConformanceScenario[] = [
  'simple-turn',
  'file-write-full-access',
  'approval-required',
  'approval-declined',
  'interrupt',
  'steer-mid-turn',
  'resume',
  'user-input',
  'subagent',
  'mcp-registered',
];

const TOKEN = 'SWITCH_CONFORMANCE_OK';

function baseEnv(extra: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'TERM']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++counter}`;

/** Starts a session only while its conformance scenario is still alive. */
export async function startConformanceSession(
  scope: { readonly closed: boolean },
  adapter: ProviderAdapter,
  input: ProviderSessionStartInput
): Promise<Awaited<ReturnType<ProviderAdapter['startSession']>>> {
  if (scope.closed) throw new Error('Conformance scenario already ended');
  try {
    const session = await adapter.startSession(input);
    if (scope.closed) throw new Error('Conformance scenario already ended');
    return session;
  } catch (error) {
    // Teardown may have run before startSession registered its process.
    if (scope.closed) await adapter.stopAll();
    throw error;
  }
}

/**
 * The behaviors every adapter must exhibit against the real provider. Each
 * scenario gets its own adapter, working directory and session, and each
 * asserts on the normalized event stream only, never on vendor payloads.
 */
export function describeConformance(name: string, options: ConformanceOptions): void {
  const timeoutMs = options.timeoutMs ?? 180_000;

  describe(`${name} conformance`, () => {
    let unavailable: string | null = null;
    beforeAll(async () => {
      unavailable = await options.unavailableReason();
    });

    interface ScenarioScope {
      adapters: ProviderAdapter[];
      dirs: string[];
      recorders: EventRecorder[];
      closed: boolean;
      cleaning?: Promise<void>;
    }
    const scopes = new Set<ScenarioScope>();

    function assertOpen(scope: ScenarioScope): void {
      if (scope.closed) throw new Error('Conformance scenario already ended');
    }

    // Cleanup is shared by the scenario's finally and Vitest's afterEach.
    // The latter also runs when Vitest times out a still-pending test body.
    async function cleanup(scope: ScenarioScope): Promise<void> {
      if (scope.cleaning) return scope.cleaning;
      scope.closed = true;
      scope.cleaning = (async () => {
        const failures: unknown[] = [];
        for (const recorder of scope.recorders.splice(0)) {
          try {
            recorder.dispose();
          } catch (error) {
            failures.push(error);
          }
        }
        const stopped = await Promise.allSettled(
          scope.adapters.map((adapter) => adapter.stopAll())
        );
        const removed = await Promise.allSettled(
          scope.dirs.map((dir) => rm(dir, { recursive: true, force: true }))
        );
        for (let index = stopped.length - 1; index >= 0; index--) {
          const result = stopped[index]!;
          if (result.status === 'fulfilled') scope.adapters.splice(index, 1);
          else failures.push(result.reason);
        }
        for (let index = removed.length - 1; index >= 0; index--) {
          const result = removed[index]!;
          if (result.status === 'fulfilled') scope.dirs.splice(index, 1);
          else failures.push(result.reason);
        }
        if (failures.length) throw new AggregateError(failures, 'Conformance cleanup failed');
        scopes.delete(scope);
      })();
      try {
        await scope.cleaning;
      } finally {
        scope.cleaning = undefined;
      }
    }

    async function cleanupAll(): Promise<void> {
      const results = await Promise.allSettled([...scopes].map(cleanup));
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (failures.length) throw new AggregateError(failures, 'Conformance cleanup failed');
    }

    afterEach(cleanupAll);
    // Retry resources whose cleanup failed, including after a timed-out test.
    afterAll(cleanupAll);

    async function createAdapter(scope: ScenarioScope): Promise<ProviderAdapter> {
      assertOpen(scope);
      const adapter = await options.createAdapter();
      if (scope.closed) {
        await adapter.stopAll();
        throw new Error('Conformance scenario ended while creating its adapter');
      }
      scope.adapters.push(adapter);
      return adapter;
    }

    function createRecorder(scope: ScenarioScope, adapter: ProviderAdapter): EventRecorder {
      assertOpen(scope);
      const recorder = new EventRecorder(adapter);
      scope.recorders.push(recorder);
      return recorder;
    }

    async function setup(
      scope: ScenarioScope,
      overrides: Partial<ProviderSessionStartInput> = {}
    ): Promise<{
      adapter: ProviderAdapter;
      recorder: EventRecorder;
      cwd: string;
      sessionId: string;
      input: ProviderSessionStartInput;
    }> {
      const adapter = await createAdapter(scope);
      const cwd = await mkdtemp(join(tmpdir(), 'switch-conformance-'));
      if (scope.closed) {
        await rm(cwd, { recursive: true, force: true });
        throw new Error('Conformance scenario ended while creating its directory');
      }
      scope.dirs.push(cwd);
      await writeFile(join(cwd, 'README.md'), '# conformance scratch\n');
      const recorder = createRecorder(scope, adapter);
      const sessionId = nextId('session');
      const input: ProviderSessionStartInput = {
        sessionId,
        cwd,
        runtimeMode: 'full-access',
        env: baseEnv(options.env),
        mcpServers: {},
        connectorMcpServers: [],
        model: options.model,
        ...overrides,
      };
      return { adapter, recorder, cwd, sessionId, input };
    }

    function scenario(id: ConformanceScenario, run: (scope: ScenarioScope) => Promise<void>) {
      it(
        id,
        async (ctx) => {
          if (unavailable) return ctx.skip(`${name} unavailable: ${unavailable}`);
          const reason = options.skip?.[id];
          if (reason) return ctx.skip(reason);
          const scope: ScenarioScope = { adapters: [], dirs: [], recorders: [], closed: false };
          scopes.add(scope);
          try {
            await run(scope);
          } finally {
            await cleanup(scope);
          }
        },
        timeoutMs
      );
    }

    scenario('simple-turn', async (scope) => {
      const { adapter, recorder, sessionId, input } = await setup(scope);
      const session = await startConformanceSession(scope, adapter, input);
      expect(session.sessionId).toBe(sessionId);
      expect(session.nativeSessionId).toBeTruthy();
      await recorder.waitFor('session.started', (e) => e.sessionId === sessionId, 30_000);

      const turnId = nextId('turn');
      const result = await adapter.sendTurn({
        sessionId,
        turnId,
        text: `Reply with exactly the text ${TOKEN} and nothing else. Do not use any tools.`,
      });
      expect(result.turnId).toBe(turnId);
      await recorder.waitFor('turn.started', (e) => e.turnId === turnId, 30_000);
      const done = await recorder.waitFor('turn.completed', (e) => e.turnId === turnId, timeoutMs);
      expect(done.outcome).toBe('completed');
      expect(recorder.assistantText(turnId)).toContain(TOKEN);
      expect(recorder.ofType('request.opened')).toHaveLength(0);

      await adapter.stopSession(sessionId);
      await recorder.waitFor('session.exited', (e) => e.sessionId === sessionId, 30_000);
      expect(adapter.hasSession(sessionId)).toBe(false);
    });

    scenario('file-write-full-access', async (scope) => {
      const { adapter, recorder, sessionId, cwd, input } = await setup(scope);
      await startConformanceSession(scope, adapter, input);
      const turnId = nextId('turn');
      await adapter.sendTurn({
        sessionId,
        turnId,
        text: `Create a file named marker.txt in the current directory containing exactly ${TOKEN}. Then reply "done".`,
      });
      const done = await recorder.waitFor('turn.completed', (e) => e.turnId === turnId, timeoutMs);
      expect(done.outcome).toBe('completed');
      expect(recorder.ofType('request.opened')).toHaveLength(0);
      const items = recorder.ofType('item.completed').map((e) => e.item.type);
      expect(items.some((t) => t === 'file_change' || t === 'command_execution')).toBe(true);
      expect((await readFile(join(cwd, 'marker.txt'), 'utf8')).trim()).toBe(TOKEN);
    });

    scenario('approval-required', async (scope) => {
      const { adapter, recorder, sessionId, cwd, input } = await setup(scope, {
        runtimeMode: 'approval-required',
      });
      await startConformanceSession(scope, adapter, input);
      const turnId = nextId('turn');
      await adapter.sendTurn({
        sessionId,
        turnId,
        text: `Run the shell command: echo ${TOKEN} > approved.txt. Then reply "done".`,
      });
      const request = await recorder.waitFor(
        'request.opened',
        (e) => e.sessionId === sessionId,
        timeoutMs
      );
      expect(['command_execution_approval', 'file_change_approval', 'tool_approval']).toContain(
        request.requestType
      );
      expect(request.options.some((o) => o.decision === 'accept')).toBe(true);
      await adapter.respondToRequest(sessionId, request.requestId, 'accept');
      await recorder.waitFor('request.resolved', (e) => e.requestId === request.requestId, 30_000);
      const done = await recorder.waitFor('turn.completed', (e) => e.turnId === turnId, timeoutMs);
      expect(done.outcome).toBe('completed');
      expect((await readFile(join(cwd, 'approved.txt'), 'utf8')).trim()).toBe(TOKEN);
    });

    scenario('approval-declined', async (scope) => {
      const { adapter, recorder, sessionId, cwd, input } = await setup(scope, {
        runtimeMode: 'approval-required',
      });
      await startConformanceSession(scope, adapter, input);
      const turnId = nextId('turn');
      await adapter.sendTurn({
        sessionId,
        turnId,
        text: `Run the shell command: echo ${TOKEN} > declined.txt. If you are not allowed to, do not try any other way; just reply "declined".`,
      });
      const request = await recorder.waitFor('request.opened', () => true, timeoutMs);
      await adapter.respondToRequest(sessionId, request.requestId, 'decline');
      const done = await recorder.waitFor('turn.completed', (e) => e.turnId === turnId, timeoutMs);
      expect(done.outcome).toBe('completed');
      await expect(readFile(join(cwd, 'declined.txt'), 'utf8')).rejects.toThrow();
    });

    scenario('interrupt', async (scope) => {
      const { adapter, recorder, sessionId, input } = await setup(scope);
      await startConformanceSession(scope, adapter, input);
      const turnId = nextId('turn');
      await adapter.sendTurn({
        sessionId,
        turnId,
        text: 'Count slowly from 1 to 500, one number per line, writing each number as you go. Do not use tools.',
      });
      await recorder.waitFor('content.delta', (e) => e.turnId === turnId, timeoutMs);
      await adapter.interruptTurn(sessionId);
      const done = await recorder.waitFor('turn.completed', (e) => e.turnId === turnId, 60_000);
      expect(done.outcome).toBe('interrupted');

      const nextTurn = nextId('turn');
      await adapter.sendTurn({ sessionId, turnId: nextTurn, text: `Reply with exactly ${TOKEN}.` });
      const next = await recorder.waitFor(
        'turn.completed',
        (e) => e.turnId === nextTurn,
        timeoutMs
      );
      expect(next.outcome).toBe('completed');
    });

    scenario('steer-mid-turn', async (scope) => {
      const { adapter, recorder, sessionId, input } = await setup(scope);
      await startConformanceSession(scope, adapter, input);
      const turnId = nextId('turn');
      await adapter.sendTurn({
        sessionId,
        turnId,
        text: 'Count slowly from 1 to 300, one number per line. Do not use tools. If I send another message, stop counting and follow it instead.',
      });
      await recorder.waitFor('content.delta', (e) => e.turnId === turnId, timeoutMs);
      const steerId = nextId('turn');
      const result = await adapter.sendTurn({
        sessionId,
        turnId: steerId,
        text: `Stop counting now. Reply with exactly ${TOKEN}.`,
      });
      const settledTurn = result.steeredInto ?? steerId;
      const done = await recorder.waitFor(
        'turn.completed',
        (e) => e.turnId === settledTurn && e.outcome === 'completed',
        timeoutMs
      );
      expect(done.outcome).toBe('completed');
      const text =
        recorder.assistantText(settledTurn) +
        (result.steeredInto ? '' : recorder.assistantText(turnId));
      expect(text).toContain(TOKEN);
    });

    scenario('resume', async (scope) => {
      const first = await setup(scope);
      const session = await startConformanceSession(scope, first.adapter, first.input);
      const turnId = nextId('turn');
      await first.adapter.sendTurn({
        sessionId: first.sessionId,
        turnId,
        text: `Remember the secret word: pelican-${TOKEN}. Reply "ok".`,
      });
      await first.recorder.waitFor('turn.completed', (e) => e.turnId === turnId, timeoutMs);
      await first.adapter.stopSession(first.sessionId);

      const second = await createAdapter(scope);
      const recorder = createRecorder(scope, second);
      const resumedId = nextId('session');
      await startConformanceSession(scope, second, {
        ...first.input,
        sessionId: resumedId,
        resume: { nativeSessionId: session.nativeSessionId },
      });
      const askId = nextId('turn');
      await second.sendTurn({
        sessionId: resumedId,
        turnId: askId,
        text: 'What was the secret word I told you? Reply with just the word.',
      });
      const done = await recorder.waitFor('turn.completed', (e) => e.turnId === askId, timeoutMs);
      expect(done.outcome).toBe('completed');
      expect(recorder.assistantText(askId)).toContain(`pelican-${TOKEN}`);
    });

    scenario('user-input', async (scope) => {
      const { adapter, recorder, sessionId, input } = await setup(scope);
      await startConformanceSession(scope, adapter, input);
      const turnId = nextId('turn');
      await adapter.sendTurn({
        sessionId,
        turnId,
        text: 'Before doing anything, ask me one clarifying multiple-choice question using your ask-the-user tool: "Which color?" with options red, green, blue. Then reply with only the color I chose.',
      });
      const request = await recorder.waitFor('user-input.requested', () => true, timeoutMs);
      expect(request.questions.length).toBeGreaterThan(0);
      const question = request.questions[0]!;
      const green =
        question.options.find((o) => /green/i.test(o.label))?.value ??
        question.options[0]?.value ??
        'green';
      await adapter.respondToUserInput(sessionId, request.requestId, { [question.id]: green });
      await recorder.waitFor(
        'user-input.resolved',
        (e) => e.requestId === request.requestId,
        30_000
      );
      const done = await recorder.waitFor('turn.completed', (e) => e.turnId === turnId, timeoutMs);
      expect(done.outcome).toBe('completed');
      expect(recorder.assistantText(turnId).toLowerCase()).toContain('green');
    });

    scenario('subagent', async (scope) => {
      const { adapter, recorder, sessionId, input } = await setup(scope);
      await startConformanceSession(scope, adapter, input);
      const turnId = nextId('turn');
      await adapter.sendTurn({
        sessionId,
        turnId,
        text: `Delegate this to a subagent (spawn a sub-agent / task agent, do not do it yourself): read README.md in the current directory and report its first line. When the subagent returns, reply with that line followed by ${TOKEN}.`,
      });
      const started = await recorder.waitFor(
        'item.started',
        (e) => e.turnId === turnId && e.item.type === 'subagent',
        timeoutMs
      );
      expect(started.item.title.length).toBeGreaterThan(0);
      const finished = await recorder.waitFor(
        'item.completed',
        (e) => e.turnId === turnId && e.item.type === 'subagent' && e.item.id === started.item.id,
        timeoutMs
      );
      expect(finished.item.status).toBe('completed');
      const done = await recorder.waitFor('turn.completed', (e) => e.turnId === turnId, timeoutMs);
      expect(done.outcome).toBe('completed');
      expect(recorder.assistantText(turnId)).toContain(TOKEN);
    });

    scenario('mcp-registered', async (scope) => {
      if (!options.mcpServers || Object.keys(options.mcpServers).length === 0) {
        throw new Error('mcp-registered needs options.mcpServers or a skip reason');
      }
      // Deliberately the mode that asks about everything else. A session's MCP
      // servers are the ones the caller registered for it — for Switch Console
      // the room protocol — so calling one must not stop for an approval. It
      // did, and the session then sat waiting for a human to allow the tool it
      // needed in order to reach that human.
      const { adapter, recorder, sessionId, input } = await setup(scope, {
        runtimeMode: 'approval-required',
        mcpServers: options.mcpServers,
        connectorMcpServers: [],
      });
      await startConformanceSession(scope, adapter, input);
      const names = Object.keys(options.mcpServers).join(', ');
      const turnId = nextId('turn');
      await adapter.sendTurn({
        sessionId,
        turnId,
        text:
          `Call the echo tool from the MCP server named ${names} with the text ` +
          `${TOKEN}, then reply with what it returned.`,
      });
      const done = await recorder.waitFor('turn.completed', (e) => e.turnId === turnId, timeoutMs);
      expect(done.outcome).toBe('completed');
      expect(recorder.ofType('request.opened')).toEqual([]);
      expect(recorder.assistantText(turnId)).toContain(TOKEN);
    });
  });
}
