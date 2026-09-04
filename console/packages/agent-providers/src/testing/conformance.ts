import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

    const adapters: ProviderAdapter[] = [];
    const dirs: string[] = [];
    afterAll(async () => {
      await Promise.allSettled(adapters.map((adapter) => adapter.stopAll()));
      await Promise.allSettled(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    });

    async function setup(overrides: Partial<ProviderSessionStartInput> = {}): Promise<{
      adapter: ProviderAdapter;
      recorder: EventRecorder;
      cwd: string;
      sessionId: string;
      input: ProviderSessionStartInput;
    }> {
      const adapter = await options.createAdapter();
      adapters.push(adapter);
      const cwd = await mkdtemp(join(tmpdir(), 'switch-conformance-'));
      dirs.push(cwd);
      await writeFile(join(cwd, 'README.md'), '# conformance scratch\n');
      const recorder = new EventRecorder(adapter);
      const sessionId = nextId('session');
      const input: ProviderSessionStartInput = {
        sessionId,
        cwd,
        runtimeMode: 'full-access',
        env: baseEnv(options.env),
        mcpServers: {},
        model: options.model,
        ...overrides,
      };
      return { adapter, recorder, cwd, sessionId, input };
    }

    function scenario(id: ConformanceScenario, run: () => Promise<void>) {
      it(
        id,
        async (ctx) => {
          if (unavailable) return ctx.skip(`${name} unavailable: ${unavailable}`);
          const reason = options.skip?.[id];
          if (reason) return ctx.skip(reason);
          await run();
        },
        timeoutMs
      );
    }

    scenario('simple-turn', async () => {
      const { adapter, recorder, sessionId, input } = await setup();
      const session = await adapter.startSession(input);
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

    scenario('file-write-full-access', async () => {
      const { adapter, recorder, sessionId, cwd, input } = await setup();
      await adapter.startSession(input);
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

    scenario('approval-required', async () => {
      const { adapter, recorder, sessionId, cwd, input } = await setup({
        runtimeMode: 'approval-required',
      });
      await adapter.startSession(input);
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

    scenario('approval-declined', async () => {
      const { adapter, recorder, sessionId, cwd, input } = await setup({
        runtimeMode: 'approval-required',
      });
      await adapter.startSession(input);
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

    scenario('interrupt', async () => {
      const { adapter, recorder, sessionId, input } = await setup();
      await adapter.startSession(input);
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

    scenario('steer-mid-turn', async () => {
      const { adapter, recorder, sessionId, input } = await setup();
      await adapter.startSession(input);
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

    scenario('resume', async () => {
      const first = await setup();
      const session = await first.adapter.startSession(first.input);
      const turnId = nextId('turn');
      await first.adapter.sendTurn({
        sessionId: first.sessionId,
        turnId,
        text: `Remember the secret word: pelican-${TOKEN}. Reply "ok".`,
      });
      await first.recorder.waitFor('turn.completed', (e) => e.turnId === turnId, timeoutMs);
      await first.adapter.stopSession(first.sessionId);

      const second = await options.createAdapter();
      adapters.push(second);
      const recorder = new EventRecorder(second);
      const resumedId = nextId('session');
      await second.startSession({
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

    scenario('user-input', async () => {
      const { adapter, recorder, sessionId, input } = await setup();
      await adapter.startSession(input);
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

    scenario('subagent', async () => {
      const { adapter, recorder, sessionId, input } = await setup();
      await adapter.startSession(input);
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

    scenario('mcp-registered', async () => {
      if (!options.mcpServers || Object.keys(options.mcpServers).length === 0) {
        throw new Error('mcp-registered needs options.mcpServers or a skip reason');
      }
      const { adapter, recorder, sessionId, input } = await setup({
        mcpServers: options.mcpServers,
      });
      await adapter.startSession(input);
      const names = Object.keys(options.mcpServers).join(', ');
      const turnId = nextId('turn');
      await adapter.sendTurn({
        sessionId,
        turnId,
        text: `List the names of the MCP tools available to you from the server(s) named ${names}. Reply with the tool names only, comma separated. Do not call any tool.`,
      });
      const done = await recorder.waitFor('turn.completed', (e) => e.turnId === turnId, timeoutMs);
      expect(done.outcome).toBe('completed');
      expect(recorder.assistantText(turnId).length).toBeGreaterThan(0);
    });
  });
}
