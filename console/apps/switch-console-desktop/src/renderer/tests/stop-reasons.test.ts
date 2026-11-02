import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { happenedAt } from '@renderer/features/managed-agents/agent-status-panel';
import {
  sharedCloudFromSession,
  sharedCloudPresentation,
} from '@renderer/features/shared-cloud/shared-cloud-state';
import {
  parseStopReason,
  resetsAt,
  STOP_REASON_CODES,
  STOP_REASON_WORDS,
  stopReasonHeading,
} from '@shared/core/stop-reasons/stop-reasons';

const now = new Date('2026-10-29T12:00:00Z');

const CORE_VISIBILITY = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'core',
  'switch_core',
  'visibility'
);
/** Core's own table of words, with its implicitly joined string literals put back together. */
const CORE_WORDS = readFileSync(join(CORE_VISIBILITY, 'stop_reasons.py'), 'utf8').replace(
  /"\s+"/g,
  ''
);
/** Core's list of codes (V1's `StopReason`). */
const CORE_CODES = readFileSync(join(CORE_VISIBILITY, 'reason_codes.py'), 'utf8');

describe('the words for why an agent stopped (visibility V2)', () => {
  it('covers exactly the nine codes Core sends', () => {
    expect(Object.keys(STOP_REASON_WORDS).sort()).toEqual([...STOP_REASON_CODES].sort());
    for (const code of STOP_REASON_CODES) expect(CORE_CODES).toContain(`= "${code}"`);
  });

  it("matches Core's table, so the Status panel and the room never differ", () => {
    for (const code of STOP_REASON_CODES) {
      const words = STOP_REASON_WORDS[code];
      expect(CORE_WORDS, `${code} heading`).toContain(`"${words.heading}"`);
      expect(CORE_WORDS, `${code} what to do`).toContain(`"${words.whatToDo}"`);
    }
    const restart = STOP_REASON_CODES.filter((code) => STOP_REASON_WORDS[code].restartHelps);
    expect(restart).toEqual(['memory_guard', 'cant_reach']);
    expect(CORE_WORDS.match(/restart_helps=True/g)?.length).toBe(2);
  });

  it('fills the wait limit into its heading', () => {
    expect(stopReasonHeading('waiting_too_long')).toBe('Still waiting for room after 10 minutes');
    expect(stopReasonHeading('waiting_too_long', 15)).toBe(
      'Still waiting for room after 15 minutes'
    );
  });

  it('says a reset in the person’s own time', () => {
    expect(resetsAt('2026-10-30T00:00:00Z', 'Europe/London')).toBe('Resets at 00:00 your time');
    expect(resetsAt('2026-10-30T00:00:00Z', 'Europe/Paris')).toBe('Resets at 01:00 your time');
  });

  it('says when it happened in one style', () => {
    expect(happenedAt('2026-10-29T10:42:00', new Date('2026-10-29T12:00:00'))).toBe(
      'Today at 10:42'
    );
    expect(happenedAt('2026-10-28T18:05:00', new Date('2026-10-29T12:00:00'))).toBe(
      'Yesterday at 18:05'
    );
  });
});

describe("the server's reason, as Console reads it", () => {
  it('takes only the nine codes with times, never other text', () => {
    expect(
      parseStopReason({ code: 'memory_guard', since: '2026-10-29T11:00:00Z', reset_at: null })
    ).toEqual({
      code: 'memory_guard',
      since: '2026-10-29T11:00:00Z',
      resetAt: null,
    });
    expect(
      parseStopReason({ code: 'budget_reached', since: null, reset_at: '2026-11-12T00:00:00Z' })
    ).toEqual({
      code: 'budget_reached',
      since: null,
      resetAt: '2026-11-12T00:00:00Z',
    });
    for (const bad of [
      null,
      undefined,
      'memory_guard',
      {},
      { code: 'something the agent wrote' },
      { code: 42 },
    ])
      expect(parseStopReason(bad)).toBeNull();
    // Extra fields are dropped, so nothing else from the server reaches the panel.
    expect(
      parseStopReason({ code: 'cant_reach', since: null, reset_at: null, detail: 'x' })
    ).toEqual({
      code: 'cant_reach',
      since: null,
      resetAt: null,
    });
  });
});

describe('the card, with the server’s reason (visibility V2)', () => {
  const agent = (code: string | null, over: Record<string, unknown> = {}) =>
    ({
      agentId: 'a1',
      desiredState: 'running',
      machine: { id: 'box', name: 'box', kind: 'ec2', state: 'online' },
      stopReason: code
        ? { code, since: '2026-10-29T11:00:00Z', resetAt: '2026-11-12T00:00:00Z' }
        : null,
      status: { process: 'running', attached: true, reason: null, detail: null, directory: null },
      ...over,
    }) as unknown as Parameters<typeof sharedCloudFromSession>[0];

  it('shows Paused by Switch, the one new card state', () => {
    const state = sharedCloudFromSession(agent('paused_by_switch'), true)!;
    expect(state).toMatchObject({ state: 'unavailable', paused: true });
    expect(sharedCloudPresentation(state, now)).toMatchObject({
      label: 'Paused by Switch',
      detail: 'Contact your admin',
      tone: 'problem',
    });
  });

  it('shows Turned off by your admin in grey, the second new card state', () => {
    const state = sharedCloudFromSession(agent('turned_off_by_admin'), true)!;
    expect(state).toMatchObject({ state: 'unavailable', turned_off: true });
    expect(sharedCloudPresentation(state, now)).toMatchObject({
      label: 'Turned off by your admin',
      detail: 'Ask your admin to turn it on',
      tone: 'off',
    });
  });

  it("gives Can't reply right now the reason's second line", () => {
    const detail = (code: string) =>
      sharedCloudPresentation(sharedCloudFromSession(agent(code), true)!, now).detail;
    expect(detail('daily_cap_reached')).toBe("Today's AI limit reached");
    expect(detail('cant_reach')).toBe("Can't reach your cloud");
    expect(detail('login_needed')).toBe('Set up your AI provider again');
    expect(detail('memory_guard')).toBe('Stopped: used too much memory');
    expect(detail('budget_reached')).toMatch(/^Budget reached, resets 1[12] Nov$/);
  });

  it('keeps the usual state for waiting, a restart and a move: the Status panel shows those', () => {
    for (const code of ['waiting_too_long', 'box_restarted', 'box_moved'])
      expect(sharedCloudFromSession(agent(code), true)).toBeNull();
  });

  it('lets a box asleep or starting keep its own state over a late can’t-reach', () => {
    const asleep = { state: 'stopped', desired_state: 'stopped', sleeping: true } as const;
    expect(sharedCloudFromSession(agent('cant_reach'), true, asleep)).toMatchObject({
      state: 'resting',
      box_stopped: true,
    });
  });

  it('shows nothing new off the shared cloud, or for a stopped agent', () => {
    expect(sharedCloudFromSession(agent('paused_by_switch'), false)).toBeNull();
    expect(
      sharedCloudFromSession(agent('cant_reach', { desiredState: 'stopped' }), true)
    ).toBeNull();
  });
});

describe('the card while a repair waits on the re-seal (V3b)', () => {
  const now = new Date('2026-10-29T12:00:00Z');
  const agent = {
    agentId: 'a1',
    desiredState: 'running',
    machine: { id: 'box', name: 'box', kind: 'ec2', state: 'online' },
    stopReason: { code: 'login_needed', since: '2026-10-29T11:00:00Z', resetAt: null },
    status: { process: 'running', attached: true, reason: null, detail: null, directory: null },
  } as unknown as Parameters<typeof sharedCloudFromSession>[0];
  const box = (reseal: string[]) =>
    ({
      state: 'ready',
      desired_state: 'running',
      sleeping: false,
      reseal_providers: reseal,
    }) as Parameters<typeof sharedCloudFromSession>[2];
  const detail = (reseal: string[], acted: boolean) =>
    sharedCloudPresentation(sharedCloudFromSession(agent, true, box(reseal), acted)!, now).detail;

  it('says the repair is finishing until a Console has acted on it', () => {
    expect(detail(['codex'], false)).toBe(
      "Finishing your cloud's repair. Open Switch Console on your computer."
    );
  });

  it('goes back to "Set up your AI provider again" once this Console has asked, or with no note', () => {
    expect(detail(['codex'], true)).toBe('Set up your AI provider again');
    expect(detail([], false)).toBe('Set up your AI provider again');
  });
});
