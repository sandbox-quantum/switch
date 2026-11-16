import type { ValveEvent } from '@switch-console/agent-providers-box';
import type { LogFields, Logger } from './log';

/**
 * The controller's own fixed log events, kept as counts and times for the
 * live status's `--since` (operators' scripts score from these instead of
 * reading the box log).
 *
 * Only the messages in `EVENT_RULES` are kept, and of each only its kind, its
 * time and the ids in it cut to 8 characters, plus a reason from a fixed list.
 * Never the message text or any other field. The logger itself is untouched:
 * every line is still written as before.
 */

export const EVENT_KINDS = [
  'agent_resting',
  'agent_woken',
  'parked_for_cap',
  'parked_for_memory',
  'starts_refused',
  'guard_stopped',
  'could_not_tell_room',
  'host_failed_too_often',
  'waited',
  'wait_granted',
  'wait_let_go',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export type LiveEvent = {
  at: number;
  kind: EventKind;
  agent: string | null;
  conversation: string | null;
  reason: string | null;
  /** How many this line stands for: a refusal line counts those since the last one. */
  count: number;
};

/** The most kept; the oldest go first. */
export const MAX_EVENTS = 2000;

const SHORT = 8;
const ID = /^[A-Za-z0-9_-]+$/;
const short = (value: unknown) =>
  typeof value === 'string' && ID.test(value) ? value.slice(0, SHORT) : null;

type Rule = {
  kind: EventKind;
  match: RegExp;
  read: (
    found: RegExpExecArray,
    fields: LogFields | undefined
  ) => Omit<LiveEvent, 'at' | 'kind' | 'count'> & { count?: number };
};

const fromFields = (_found: RegExpExecArray, fields: LogFields | undefined) => ({
  agent: short(fields?.agentId),
  conversation: null,
  reason: null,
});

/** The reasons the box valve refuses a start with (`RefuseReason`), and nothing else. */
const REFUSE_REASONS = ['busy', 'cap', 'memory', 'limit', 'held'] as const;

export const EVENT_RULES: readonly Rule[] = [
  {
    kind: 'agent_resting',
    match: /^Agent is resting: stopping its agent host/,
    read: fromFields,
  },
  { kind: 'agent_woken', match: /^Starting a suspended agent’s host/, read: fromFields },
  {
    kind: 'parked_for_cap',
    match: /^Parking session (\S+) of agent (\S+) early: the box is at its cap/,
    read: (found) => ({ conversation: short(found[1]), agent: short(found[2]), reason: null }),
  },
  {
    kind: 'parked_for_memory',
    match: /^Parking session (\S+) of agent (\S+) early: the box is at \d+% of its memory/,
    read: (found) => ({ conversation: short(found[1]), agent: short(found[2]), reason: null }),
  },
  {
    kind: 'starts_refused',
    match: /^Refusing session starts: (\w+) \((\d+) since the last line\)/,
    read: (found) => ({
      agent: null,
      conversation: null,
      reason: REFUSE_REASONS.find((known) => known === found[1]) ?? 'other',
      count: Math.min(Number(found[2]), 1_000_000),
    }),
  },
  { kind: 'guard_stopped', match: /^Memory guard stopped an agent/, read: fromFields },
  { kind: 'could_not_tell_room', match: /^Could not tell (the|a) room/, read: fromFields },
  {
    kind: 'host_failed_too_often',
    match: /^Agent host failed too often/,
    read: fromFields,
  },
];

export class LiveEvents {
  private readonly events: LiveEvent[] = [];
  /** When the oldest kept event's predecessors were dropped, or null if none were. */
  private droppedBefore: number | null = null;

  constructor(private readonly now: () => number) {}

  /** Keeps `message` if it is one of the fixed events. */
  note(message: string, fields: LogFields | undefined): void {
    for (const rule of EVENT_RULES) {
      const found = rule.match.exec(message);
      if (!found) continue;
      const { count, ...read } = rule.read(found, fields);
      this.push({ at: this.now(), kind: rule.kind, count: count ?? 1, ...read });
      return;
    }
  }

  /** A wait-list change from the box valve (`BoxValveOptions.onEvent`), already cut to 8. */
  noteValve(event: ValveEvent): void {
    this.push({
      at: this.now(),
      kind:
        event.kind === 'wait'
          ? 'waited'
          : event.kind === 'granted'
            ? 'wait_granted'
            : 'wait_let_go',
      agent: short(event.agent),
      conversation: short(event.conversation),
      reason: event.reason,
      count: 1,
    });
  }

  private push(event: LiveEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      const dropped = this.events.shift()!;
      this.droppedBefore = dropped.at;
    }
  }

  snapshot(): { events: LiveEvent[]; droppedBefore: number | null } {
    return { events: [...this.events], droppedBefore: this.droppedBefore };
  }
}

/** `log`, also telling `events` each line. Recording never stops a line being logged. */
export function teeLogger(log: Logger, events: LiveEvents): Logger {
  const noting =
    (write: (message: string, fields?: LogFields) => void) =>
    (message: string, fields?: LogFields) => {
      write(message, fields);
      try {
        events.note(message, fields);
      } catch {
        // A window for an operator: never a reason for a log line to fail.
      }
    };
  return {
    debug: log.debug,
    info: noting(log.info),
    warn: noting(log.warn),
    error: noting(log.error),
  };
}
