import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVENT_RULES, LiveEvents, MAX_EVENTS, teeLogger } from './live-events';
import type { Logger } from './log';

const T0 = Date.parse('2026-10-28T16:00:00.000Z');

function logger(lines: string[]): Logger {
  const write = (message: string) => lines.push(message);
  return { debug: write, info: write, warn: write, error: write };
}

describe('LiveEvents through the logger', () => {
  it('keeps the fixed events, with ids cut to 8, and logs every line as before', () => {
    const lines: string[] = [];
    const events = new LiveEvents(() => T0);
    const log = teeLogger(logger(lines), events);
    log.info('Agent is resting: stopping its agent host until its next message', {
      agentId: '7b1e5c0a-1111-4222-8333-944455556666',
    });
    log.info('Starting a suspended agent’s host for what it must answer', { agentId: 'agent-2' });
    log.info(
      'Parking session 0a1b2c3d4e5f of agent 7b1e5c0a-1111 early: the box is at its cap of 12 awake sessions.'
    );
    log.info(
      'Parking session 9f8e7d6c of agent 11112222-3333 early: the box is at 91% of its memory.'
    );
    log.warn('Refusing session starts: cap (7 since the last line).');
    log.warn('Memory guard stopped an agent', { agentId: 'agent-3', note: 'secret text' });
    log.warn('Could not tell the room about background processes stopped at rest', {
      agentId: 'agent-4',
    });
    log.info('Pulled assignment', { revision: 3 });
    expect(lines).toHaveLength(8);
    expect(events.snapshot().events).toEqual([
      {
        at: T0,
        kind: 'agent_resting',
        agent: '7b1e5c0a',
        conversation: null,
        reason: null,
        count: 1,
      },
      { at: T0, kind: 'agent_woken', agent: 'agent-2', conversation: null, reason: null, count: 1 },
      {
        at: T0,
        kind: 'parked_for_cap',
        agent: '7b1e5c0a',
        conversation: '0a1b2c3d',
        reason: null,
        count: 1,
      },
      {
        at: T0,
        kind: 'parked_for_memory',
        agent: '11112222',
        conversation: '9f8e7d6c',
        reason: null,
        count: 1,
      },
      { at: T0, kind: 'starts_refused', agent: null, conversation: null, reason: 'cap', count: 7 },
      {
        at: T0,
        kind: 'guard_stopped',
        agent: 'agent-3',
        conversation: null,
        reason: null,
        count: 1,
      },
      {
        at: T0,
        kind: 'could_not_tell_room',
        agent: 'agent-4',
        conversation: null,
        reason: null,
        count: 1,
      },
    ]);
  });

  it('never keeps an id that is not one, or a reason off the list', () => {
    const events = new LiveEvents(() => T0);
    events.note('Agent is resting: stopping its agent host', {
      agentId: 'has spaces / and slashes',
    });
    events.note('Refusing session starts: whatever (2 since the last line).', undefined);
    expect(events.snapshot().events.map((e) => [e.agent, e.reason])).toEqual([
      [null, null],
      [null, 'other'],
    ]);
  });

  it('keeps the newest and says when older ones were dropped', () => {
    let now = T0;
    const events = new LiveEvents(() => now);
    for (let i = 0; i < MAX_EVENTS + 5; i++) {
      now = T0 + i;
      events.note('Agent is resting: stopping its agent host', { agentId: 'a' });
    }
    const { events: kept, droppedBefore } = events.snapshot();
    expect(kept).toHaveLength(MAX_EVENTS);
    expect(kept[0]!.at).toBe(T0 + 5);
    expect(droppedBefore).toBe(T0 + 4);
  });

  it('never fails a log line when recording throws', () => {
    const lines: string[] = [];
    const events = new LiveEvents(() => {
      throw new Error('clock broke');
    });
    const log = teeLogger(logger(lines), events);
    expect(() =>
      log.info('Agent is resting: stopping its agent host', { agentId: 'a' })
    ).not.toThrow();
    expect(lines).toEqual(['Agent is resting: stopping its agent host']);
  });
});

/**
 * The fixed list is pinned to the code: each event's message, as the source
 * writes it, still matches its rule. A log line reworded underneath the
 * live status fails here, not silently in a scale test.
 */
const SOURCES: Record<string, { file: string; snippet: string; message: string }> = {
  agent_resting: {
    file: 'rest.ts',
    snippet: "'Agent is resting: stopping its agent host until its next message'",
    message: 'Agent is resting: stopping its agent host until its next message',
  },
  agent_woken: {
    file: 'rest.ts',
    snippet: "'Starting a suspended agent’s host for what it must answer'",
    message: 'Starting a suspended agent’s host for what it must answer',
  },
  parked_for_cap: {
    file: '../../agent-providers-box/src/host/box-valve.ts',
    snippet:
      '`Parking session ${parked.sessionId} of agent ${parked.connection.agentId} early: the box is at its cap of ${this.cap} awake sessions.`',
    message: 'Parking session s1 of agent a1 early: the box is at its cap of 12 awake sessions.',
  },
  parked_for_memory: {
    file: '../../agent-providers-box/src/host/box-valve.ts',
    snippet:
      '`Parking session ${result.sessionId} of agent ${result.connection.agentId} early: the box is at ${percent(usage)}% of its memory.`',
    message: 'Parking session s1 of agent a1 early: the box is at 88% of its memory.',
  },
  starts_refused: {
    file: '../../agent-providers-box/src/host/box-valve.ts',
    snippet: '`Refusing session starts: ${reason} (${seen.count} since the last line).`',
    message: 'Refusing session starts: memory (3 since the last line).',
  },
  guard_stopped: {
    file: 'memory-guard.ts',
    snippet: "'Memory guard stopped an agent'",
    message: 'Memory guard stopped an agent',
  },
  could_not_tell_room: {
    file: 'rest.ts',
    snippet: "'Could not tell the room about background processes stopped at rest'",
    message: 'Could not tell the room about background processes stopped at rest',
  },
  host_failed_too_often: {
    file: 'runtime.ts',
    snippet: "'Agent host failed too often; it stays down until restarted'",
    message: 'Agent host failed too often; it stays down until restarted',
  },
};

describe('the fixed event list', () => {
  it('names each rule’s message as the source writes it, and the rule matches it', () => {
    const byName = (a: string, b: string) => a.localeCompare(b);
    expect(Object.keys(SOURCES).sort(byName)).toEqual(
      EVENT_RULES.map((rule) => rule.kind).sort(byName)
    );
    for (const rule of EVENT_RULES) {
      const source = SOURCES[rule.kind]!;
      const text = readFileSync(join(import.meta.dirname, source.file), 'utf8');
      expect(text, `${rule.kind}: the message is no longer in ${source.file}`).toContain(
        source.snippet
      );
      expect(rule.match.test(source.message), `${rule.kind}: its rule no longer matches`).toBe(
        true
      );
    }
  });

  it('counts the valve’s wait-list changes', () => {
    const events = new LiveEvents(() => T0);
    events.noteValve({ kind: 'wait', agent: 'agent-aa', conversation: 'session-', reason: null });
    events.noteValve({
      kind: 'granted',
      agent: 'agent-aa',
      conversation: 'session-',
      reason: null,
    });
    events.noteValve({
      kind: 'let_go',
      agent: 'agent-bb',
      conversation: 'b-9',
      reason: 'agent_full',
    });
    expect(events.snapshot().events.map((e) => [e.kind, e.agent, e.reason])).toEqual([
      ['waited', 'agent-aa', null],
      ['wait_granted', 'agent-aa', null],
      ['wait_let_go', 'agent-bb', 'agent_full'],
    ]);
  });
});
