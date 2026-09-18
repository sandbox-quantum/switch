/**
 * Scratch check: is the Switch skill actually in an isolated session?
 *
 * The adapter points OpenCode at a config home Switch Console writes, which
 * hides the user's own `~/.config/opencode/skills`. The registry supplies the
 * room-workflow skill back; this asserts the session can see it, which no unit
 * test can — OpenCode decides what a session may load, not us.
 *
 *   SWITCH_SMOKE=1 pnpm exec vitest run --project node \
 *     src/main/core/agent-runtime/impl/provider-skill-check.smoke.test.ts
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpencodeAdapter, type ProviderRuntimeEvent } from '@switch-console/agent-providers';
import { OPENCODE_SKILL_CONTENT } from '@switch-console/plugins/agents/opencode/skill';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const RUN = process.env.SWITCH_SMOKE === '1';
const MODEL = process.env.SWITCH_SMOKE_MODEL ?? 'opencode/big-pickle';

describe.skipIf(!RUN)('the Switch skill in an isolated OpenCode session', () => {
  let cwd: string;

  beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'switch-skill-smoke-'));
  });

  afterAll(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  it('is listed among the sessionable skills', { timeout: 5 * 60_000 }, async () => {
    const adapter = createOpencodeAdapter({
      skills: [{ name: 'switch', content: OPENCODE_SKILL_CONTENT }],
    });
    const text: string[] = [];
    let done = false;
    adapter.subscribe((event: ProviderRuntimeEvent) => {
      if (event.type === 'content.delta') text.push(event.delta);
      if (event.type === 'turn.completed') done = true;
    });

    await adapter.startSession({
      sessionId: 'skill-check',
      cwd,
      runtimeMode: 'full-access',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      },
      mcpServers: {},
      model: { id: MODEL },
    });
    await adapter.sendTurn({
      sessionId: 'skill-check',
      turnId: 't1',
      text: 'List the names of every skill available to you, one per line. Do not load any of them.',
    });

    const deadline = Date.now() + 4 * 60_000;
    while (!done && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await adapter.stopSession('skill-check');

    expect(text.join('').toLowerCase()).toContain('switch');
  });
});
