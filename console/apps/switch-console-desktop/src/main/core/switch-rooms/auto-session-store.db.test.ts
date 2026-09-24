import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

const {
  listAutoSessionAgentIds,
  listAutoSessionSubagents,
  listStoppedControllerAgentIds,
  setAutoSessionAgent,
  setAutoSessionSubagent,
  setControllerStopped,
} = await import('./auto-session-store');

let fixture: Awaited<ReturnType<typeof openFixture>>;

beforeEach(async () => {
  fixture = await openFixture('empty');
  mocks.db = fixture.db;
});

afterEach(() => {
  mocks.db = undefined;
  fixture.close();
});

it('keeps both agents stopped when two controllers are stopped at once', async () => {
  // This key is the whole record that an agent was taken off the air by hand,
  // and boot reads it to decide who stays off. Losing a member here is not a
  // stale list until the next write — it is an agent back on the air.
  await Promise.all([setControllerStopped('agent-1', true), setControllerStopped('agent-2', true)]);

  expect((await listStoppedControllerAgentIds()).sort()).toEqual(['agent-1', 'agent-2']);
});

it('does not put an agent back in the auto-session mirror because another was added', async () => {
  await setAutoSessionAgent('agent-1', true);

  await Promise.all([setAutoSessionAgent('agent-1', false), setAutoSessionAgent('agent-2', true)]);

  expect(await listAutoSessionAgentIds()).toEqual(['agent-2']);
});

it('keeps both subagents when two are enabled at once', async () => {
  await Promise.all([
    setAutoSessionSubagent('agent-1', 'one', true),
    setAutoSessionSubagent('agent-1', 'two', true),
  ]);

  expect((await listAutoSessionSubagents()).map((subagent) => subagent.name).sort()).toEqual([
    'one',
    'two',
  ]);
});
