/**
 * Why an agent stopped or can't take work (visibility V2, spec U1). Core decides the reason and sends a fixed
 * code with times; Console only shows it, in the words below. These are the designer's copy,
 * and a test checks the headings and "what to do" lines against Core's own
 * table (`core/switch_core/visibility/stop_reasons.py`), so the Status panel and the room never differ.
 *
 * Nothing here ever shows text from the agent or its box: only these words, times and a reset time.
 */

export const STOP_REASON_CODES = [
  'memory_guard',
  'box_restarted',
  'box_moved',
  'waiting_too_long',
  'daily_cap_reached',
  'budget_reached',
  'paused_by_switch',
  'turned_off_by_admin',
  'login_needed',
  'cant_reach',
] as const;
export type StopReasonCode = (typeof STOP_REASON_CODES)[number];

export type StopReason = {
  code: StopReasonCode;
  /** When it began; null where Core holds no start time (a budget records only its reset). */
  since: string | null;
  /** The daily cap and budgets only. */
  resetAt: string | null;
};

/** Core's `stop_reason`, or null for anything that isn't exactly one of the nine codes with times. */
export function parseStopReason(value: unknown): StopReason | null {
  if (!value || typeof value !== 'object') return null;
  const { code, since, reset_at } = value as {
    code?: unknown;
    since?: unknown;
    reset_at?: unknown;
  };
  if (typeof code !== 'string' || !(STOP_REASON_CODES as readonly string[]).includes(code))
    return null;
  return {
    code: code as StopReasonCode,
    since: typeof since === 'string' ? since : null,
    resetAt: typeof reset_at === 'string' ? reset_at : null,
  };
}

export type StopReasonWords = {
  /** The Status panel's heading. `{minutes}` is the wait limit. */
  heading: string;
  /** The Status panel's one "What to do" line (the spec's next step). */
  whatToDo: string;
  /** The panel offers "Restart agent". */
  restartHelps: boolean;
  /** Red for a stop, grey for turned off, amber for "back in a moment". */
  tone: 'problem' | 'off' | 'waking';
};

export const STOP_REASON_WORDS: Record<StopReasonCode, StopReasonWords> = {
  memory_guard: {
    heading: 'Stopped: this agent used too much memory',
    whatToDo: 'Send again; try a smaller task',
    restartHelps: true,
    tone: 'problem',
  },
  box_restarted: {
    heading: 'Your cloud restarted',
    whatToDo: 'Send again if a reply was cut off',
    restartHelps: false,
    tone: 'waking',
  },
  box_moved: {
    heading: 'Your cloud moved to another machine',
    whatToDo: "Nothing; it's back in a moment",
    restartHelps: false,
    tone: 'waking',
  },
  waiting_too_long: {
    heading: 'Still waiting for room after {minutes} minutes',
    whatToDo: 'Try again later',
    restartHelps: false,
    tone: 'waking',
  },
  daily_cap_reached: {
    heading: "Today's AI limit reached",
    whatToDo: 'It resets at the time shown',
    restartHelps: false,
    tone: 'problem',
  },
  budget_reached: {
    heading: 'A budget for this agent has been reached',
    whatToDo: 'Ask a workspace admin to raise the budget, or wait until it resets',
    restartHelps: false,
    tone: 'problem',
  },
  paused_by_switch: {
    heading: 'Paused by Switch',
    whatToDo: 'Contact your admin',
    restartHelps: false,
    tone: 'problem',
  },
  turned_off_by_admin: {
    heading: 'Hosted agents turned off by your admin',
    whatToDo: 'Ask your admin to turn it on',
    restartHelps: false,
    tone: 'off',
  },
  login_needed: {
    heading: 'Your AI login needs setting up again',
    whatToDo:
      'Give your AI login once more in Add agent → Set up AI provider. Your agents and their work are all still there.',
    restartHelps: false,
    tone: 'problem',
  },
  cant_reach: {
    heading: "Can't reach your cloud right now",
    whatToDo: "We're on it; try again in a few minutes",
    restartHelps: true,
    tone: 'problem',
  },
};

/** The Status panel heading, with the wait limit filled in. */
export function stopReasonHeading(code: StopReasonCode, waitLimitMinutes = 10): string {
  return STOP_REASON_WORDS[code].heading.replace('{minutes}', String(waitLimitMinutes));
}

/** A reset time in the person's own time, as the copy has it: "Resets at 01:00 your time". */
export function resetsAt(iso: string, timeZone?: string): string {
  const time = new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  });
  return `Resets at ${time} your time`;
}
