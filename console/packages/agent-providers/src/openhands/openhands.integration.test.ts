import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProviderRuntimeEvent } from '../events';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import {
  checkOpenhandsSettings,
  createOpenhandsAdapter,
  OPENHANDS_ACP_SHIM,
  openhandsHome,
  openhandsPython,
  openhandsSettingsModel,
} from './openhands-acp';

const env = { HOME: process.env.HOME ?? '' };

async function unavailableReason(): Promise<string | null> {
  const probe = spawnSync('openhands', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return 'the openhands binary is not on PATH';
  const settings = await checkOpenhandsSettings(env);
  return settings.status === 'authenticated' ? null : settings.message;
}

describeConformance('openhands', {
  createAdapter: async () => createOpenhandsAdapter(),
  unavailableReason,
  skip: {
    'user-input':
      'OpenHands CLI 1.16 (2026-11-05) gives its agent no ask-the-user tool and its ACP server sends no question requests; it asks in prose, which reaches the room as a reply.',
  },
  mcpServers: { echo: echoMcpServerSpec() },
});

describe('openhands launch shim', () => {
  it('finds everything it patches in the installed CLI', async (ctx) => {
    const reason = await unavailableReason();
    if (reason) return ctx.skip(reason);
    const python = await openhandsPython('openhands', process.env.PATH);
    expect(python).not.toBeNull();
    const result = spawnSync(python!, ['-I', '-c', OPENHANDS_ACP_SHIM, '--help'], {
      encoding: 'utf8',
      env: { ...process.env, OPENHANDS_SUPPRESS_BANNER: '1' },
    });
    expect(result.stderr).not.toContain('Switch cannot');
    expect(result.status).toBe(0);
  }, 60_000);
});

// Its session/load drops the session's MCP servers, so a resumed session is
// started with `--resume` instead. The shared resume scenario only checks the
// conversation is remembered; this checks the session's tools still answer.
describe('openhands resumed', () => {
  it('reaches the session MCP server after a resume', async (ctx) => {
    const reason = await unavailableReason();
    if (reason) return ctx.skip(reason);
    const cwd = await mkdtemp(join(tmpdir(), 'openhands-resume-'));
    const token = `SWITCH_RESUMED_${Date.now()}`;
    const input = {
      cwd,
      runtimeMode: 'approval-required' as const,
      env: { ...env, PATH: process.env.PATH ?? '' },
      mcpServers: { echo: echoMcpServerSpec() },
      connectorMcpServers: [],
    };
    const turn = async (
      adapter: ReturnType<typeof createOpenhandsAdapter>,
      sessionId: string,
      text: string
    ) => {
      const events: ProviderRuntimeEvent[] = [];
      const done = new Promise<void>((resolve) =>
        adapter.subscribe((event) => {
          events.push(event);
          if (event.type === 'turn.completed') resolve();
        })
      );
      await adapter.sendTurn({ sessionId, turnId: `t-${Date.now()}`, text });
      await done;
      return events;
    };
    const first = createOpenhandsAdapter();
    const started = await first.startSession({ sessionId: 'before', ...input });
    await turn(first, 'before', 'Remember the word heron. Reply "ok".');
    await first.stopAll();
    const second = createOpenhandsAdapter();
    try {
      await second.startSession({
        sessionId: 'after',
        ...input,
        resume: { nativeSessionId: started.nativeSessionId },
      });
      const events = await turn(
        second,
        'after',
        `Call the echo tool from the MCP server named echo with the text ${token}, then reply with what it returned.`
      );
      expect(events.some((e) => e.type === 'request.opened')).toBe(false);
      expect(
        events.some(
          (e) =>
            e.type === 'item.completed' &&
            e.item.type === 'mcp_tool_call' &&
            e.item.status === 'completed'
        )
      ).toBe(true);
      expect(
        events
          .filter((e) => e.type === 'content.delta')
          .map((e) => (e.type === 'content.delta' ? e.delta : ''))
          .join('')
      ).toContain(token);
    } finally {
      await second.stopAll();
    }
  }, 300_000);
});

// OpenHands ignores ACP's model switch, so the shared suite cannot tell which
// model ran. Its own record of the conversation can: it books usage per model.
describe('openhands models', () => {
  it('runs the session on the model its settings name, the one the session lists', async (ctx) => {
    const reason = await unavailableReason();
    if (reason) return ctx.skip(reason);
    const model = (await openhandsSettingsModel(env))!;
    const adapter = createOpenhandsAdapter();
    const done = new Promise<ProviderRuntimeEvent>((resolve) =>
      adapter.subscribe((event) => {
        if (event.type === 'turn.completed') resolve(event);
      })
    );
    const session = await adapter.startSession({
      sessionId: 'settings-model',
      cwd: await mkdtemp(join(tmpdir(), 'openhands-model-')),
      runtimeMode: 'full-access',
      env: { ...env, PATH: process.env.PATH ?? '' },
      mcpServers: {},
      connectorMcpServers: [],
      model: { id: model },
    });
    try {
      expect(await adapter.listModels('settings-model')).toEqual([
        { id: model, label: model, options: {} },
      ]);
      await adapter.sendTurn({
        sessionId: 'settings-model',
        turnId: 't',
        text: 'Reply with exactly: ok',
        model: { id: model },
      });
      expect(await done).toMatchObject({ outcome: 'completed' });
      const state = JSON.parse(
        await readFile(
          join(
            openhandsHome(env),
            'conversations',
            session.nativeSessionId.replaceAll('-', ''),
            'base_state.json'
          ),
          'utf8'
        )
      ) as {
        stats: { usage_to_metrics: { agent: { accumulated_token_usage: { model: string } } } };
      };
      expect(state.stats.usage_to_metrics.agent.accumulated_token_usage.model).toBe(model);
    } finally {
      await adapter.stopAll();
    }
  }, 180_000);
});
