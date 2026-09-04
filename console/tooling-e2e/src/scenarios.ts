import type { Harness } from './harness.ts';
import { sleep, type MattermostPost } from './mattermost-client.ts';

/**
 * The scenarios. Each one drives the full path
 *
 *     Mattermost channel -> Switch room -> Switch Console session -> agent -> room
 *
 * by posting as a human and waiting on what the agent's bot posts back. Nothing
 * here talks to Switch Console directly: if a scenario passes, a real operator
 * doing the same thing by hand would have seen the same result.
 *
 * A scenario **never throws past its own boundary** — a failure is a
 * `{ ok: false }` result carrying the transcript it did see, so one broken
 * behaviour does not hide the other three.
 */

export interface ScenarioResult {
  name: string;
  ok: boolean;
  details: string;
  transcript: MattermostPost[];
  durationMs: number;
}

export type Scenario = (harness: Harness) => Promise<ScenarioResult>;

/** How long a scenario waits for the agent to say something. */
const REPLY_DEADLINE_MS = Number(process.env.SWITCH_E2E_REPLY_TIMEOUT_MS ?? 5 * 60_000);

/**
 * Phrases Switch itself posts **as the agent's own bot** when there is no live
 * session — the onboarding notice, and the command handlers' refusals.
 *
 * They have to be recognised rather than treated as agent output, because they
 * are indistinguishable from it by author: verified against a live server, the
 * "I'm not online in this room" notice arrives from the agent's bot account, not
 * from the Switch Admin bot. A scenario that accepts any bot post therefore
 * passes with no session running at all — which is exactly the silent-green
 * failure this harness exists to rule out.
 */
const NO_SESSION_MARKERS = [
  "i'm not online in this room",
  "i don't have a session connected to this room",
  "isn't reporting as live",
  'no active session in this room',
  "i can't be interrupted",
  'this isn’t supported for me',
  "my session wasn't started from switch console",
  'open switch console to bring me online',
];

/** Whether a post is one of Switch's own no-session notices rather than agent output. */
export function isNoSessionNotice(post: MattermostPost): boolean {
  const text = post.message.toLowerCase();
  return NO_SESSION_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Turn a no-session notice into the failure it is. Every scenario funnels its
 * "the agent said nothing useful" path through here so the report names the
 * cause — no session — instead of a bare timeout.
 */
function assertNotNoSession(posts: MattermostPost[]): void {
  const notice = posts.find(isNoSessionNotice);
  if (notice) {
    throw new Error(
      `No live Switch Console session for this agent — Switch answered on its behalf: ` +
        `«${notice.message.replace(/\s+/g, ' ').slice(0, 200)}»`
    );
  }
}

/** The marker the agent is asked to echo — distinctive enough to grep a channel for. */
export const OK_MARKER = 'SWITCH_E2E_OK';

/**
 * Wrap a scenario body so it always resolves to a result. An exception becomes
 * `ok: false` with the message as `details`; the transcript collected so far is
 * whatever the body managed to record.
 */
async function scenario(
  name: string,
  body: (record: (posts: MattermostPost[]) => void) => Promise<string>
): Promise<ScenarioResult> {
  const started = Date.now();
  let transcript: MattermostPost[] = [];
  const record = (posts: MattermostPost[]): void => {
    const seen = new Set(transcript.map((post) => post.id));
    transcript = [...transcript, ...posts.filter((post) => !seen.has(post.id))].sort(
      (a, b) => a.create_at - b.create_at
    );
  };

  try {
    const details = await body(record);
    return { name, ok: true, details, transcript, durationMs: Date.now() - started };
  } catch (error) {
    return {
      name,
      ok: false,
      details: error instanceof Error ? error.message : String(error),
      transcript,
      durationMs: Date.now() - started,
    };
  }
}

/** Post `@agent <text>` and return the moment just before it was posted. */
async function ask(harness: Harness, text: string): Promise<number> {
  const sinceMs = Date.now() - 1;
  await harness.mattermost.post({
    channelId: harness.channel.id,
    message: `@${harness.agent.name} ${text}`,
  });
  return sinceMs;
}

/** Wait for a bot post matching `predicate`, or throw with the transcript. */
async function expectBotPost(
  harness: Harness,
  params: {
    since: number;
    predicate: (post: MattermostPost) => boolean;
    describe: string;
    deadlineMs?: number;
    record: (posts: MattermostPost[]) => void;
  }
): Promise<MattermostPost> {
  const { match, transcript } = await harness.mattermost.waitForPost({
    channelId: harness.channel.id,
    fromUserId: harness.bot.id,
    // A no-session notice is never a match, however permissive the caller's
    // predicate — it is Switch talking, not the agent.
    predicate: (post) => !isNoSessionNotice(post) && params.predicate(post),
    sinceMs: params.since,
    deadlineMs: params.deadlineMs ?? REPLY_DEADLINE_MS,
  });
  params.record(transcript);
  if (!match) {
    assertNotNoSession(transcript);
    throw new Error(
      `Timed out waiting for ${params.describe}. Channel said: ${summarise(transcript)}`
    );
  }
  return match;
}

function summarise(posts: MattermostPost[]): string {
  if (posts.length === 0) return '(nothing at all — no session ever replied)';
  return posts.map((post) => `«${post.message.replace(/\s+/g, ' ').slice(0, 160)}»`).join(' | ');
}

function lower(post: MattermostPost): string {
  return post.message.toLowerCase();
}

// ── greet ────────────────────────────────────────────────────────────────────

/**
 * The smoke test: does an addressed message reach a session at all, and does its
 * answer come back into the channel as the agent's bot?
 *
 * Everything else assumes this passes. A failure here means either no session is
 * running for the agent, or nothing is relaying the room's events into it.
 */
export const greet: Scenario = (harness) =>
  scenario('greet', async (record) => {
    const since = await ask(harness, `reply with exactly ${OK_MARKER} and nothing else`);
    const match = await expectBotPost(harness, {
      since,
      record,
      predicate: (post) => post.message.includes(OK_MARKER),
      describe: `a reply containing ${OK_MARKER}`,
    });
    return `bot replied in post ${match.id}`;
  });

// ── question ─────────────────────────────────────────────────────────────────

const CHOICES = ['red', 'green', 'blue'] as const;
const CHOSEN = 'green';

/**
 * A two-turn exchange: the agent asks a clarifying question, the human answers
 * in the channel, and the agent uses the answer.
 *
 * This is the round trip a one-shot reply cannot fake — it only passes if the
 * session is still alive and still connected to the room when the second message
 * arrives, which is the thing an injected-prompt runtime most easily gets wrong.
 */
export const question: Scenario = (harness) =>
  scenario('question', async (record) => {
    const since = await ask(
      harness,
      'before answering, ask me one clarifying question offering exactly the options ' +
        `${CHOICES.join(', ')} — list all three — then wait for my answer and reply with ` +
        'the single word I chose.'
    );

    const asked = await expectBotPost(harness, {
      since,
      record,
      // The options may arrive as a native prompt rendered into the room or as
      // ordinary prose; all this asserts is that all three were offered.
      predicate: (post) => CHOICES.every((choice) => lower(post).includes(choice)),
      describe: `a question listing the options ${CHOICES.join('/')}`,
    });

    const answeredAt = await ask(harness, CHOSEN);
    const answer = await expectBotPost(harness, {
      since: answeredAt,
      record,
      predicate: (post) => lower(post).includes(CHOSEN),
      describe: `a reply naming my choice '${CHOSEN}'`,
    });

    return `asked in ${asked.id}, answered in ${answer.id}`;
  });

// ── approval ─────────────────────────────────────────────────────────────────

const APPROVAL_HINTS = ['approve', 'approval', 'permission', 'allow', 'permit', 'proceed'];

/**
 * A tool call the agent is not pre-authorised to make: the session must surface
 * the permission request into the room, take `1` (allow) from the channel, and
 * then actually run the command.
 *
 * Requires the agent's session to be running WITHOUT auto-approve. Note that an
 * OpenCode agent's registered profile declares no `pre_invocation_mediation`, so
 * the prompt does not come from Switch mediating the call — it comes from the
 * console runtime relaying OpenCode's own permission request into the room. This
 * is the scenario most tightly coupled to that runtime.
 */
export const approval: Scenario = (harness) =>
  scenario('approval', async (record) => {
    const file = `approved-${harness.runId}.txt`;
    const since = await ask(
      harness,
      `run the shell command \`echo ${OK_MARKER} > ${file}\` and then reply with the single word done`
    );

    const prompt = await expectBotPost(harness, {
      since,
      record,
      predicate: (post) =>
        APPROVAL_HINTS.some((hint) => lower(post).includes(hint)) ||
        /(^|\n)\s*1[.)]/.test(post.message),
      describe: 'an approval prompt for the shell command',
    });

    const approvedAt = await ask(harness, '1');
    const done = await expectBotPost(harness, {
      since: approvedAt,
      record,
      predicate: (post) => lower(post).includes('done'),
      describe: "a 'done' reply after the command was approved",
    });

    return `prompted in ${prompt.id}, completed in ${done.id}`;
  });

// ── interrupt ────────────────────────────────────────────────────────────────

/**
 * `!interrupt @agent-name` — the in-room control command (see
 * `core/switch_core/bridges/agent/commands.py`). Slack exposes the same thing as
 * `/interrupt`; on Mattermost it is the `!` form, and **a target is required** —
 * a bare `!interrupt` addresses nobody and the admin bot replies saying so.
 *
 * For an OpenCode agent `command_capabilities.interrupt` is `session_dependent`:
 * it works only while Switch Console is driving the session and can write to it.
 * A standalone `opencode` answers that it cannot be interrupted from here, which
 * is a legitimate — and detected — outcome rather than a silent pass.
 *
 * The assertion is the absence of further output: once interrupted, the agent
 * must stop producing posts.
 */
export const interrupt: Scenario = (harness) =>
  scenario('interrupt', async (record) => {
    const since = await ask(
      harness,
      'count slowly from 1 to 200, posting each number to this room on its own message, ' +
        'and do not stop until you reach 200'
    );

    // Requiring a digit rather than accepting any post is what keeps this
    // honest: Switch's own no-session notice is filtered out above, and a bare
    // acknowledgement is not evidence the task started.
    const started = await expectBotPost(harness, {
      since,
      record,
      predicate: (post) => /\d/.test(post.message),
      describe: 'the agent to start the counting task (a post containing a number)',
      deadlineMs: Math.min(REPLY_DEADLINE_MS, 3 * 60_000),
    });

    const interruptedAt = Date.now() - 1;
    await harness.mattermost.post({
      channelId: harness.channel.id,
      message: `!interrupt @${harness.agent.name}`,
    });

    // The command is not instantaneous — the session has to be told, and posts
    // already in flight still land. Let it settle, then require silence.
    await sleep(20_000);
    const settledAt = Date.now();
    await sleep(45_000);

    const after = await harness.mattermost.postsFrom(harness.channel.id, harness.bot.id, settledAt);
    const sinceInterrupt = await harness.mattermost.postsSince(harness.channel.id, interruptedAt);
    record(sinceInterrupt);

    // `interrupt` is `session_dependent` for OpenCode: a session Switch Console
    // is not driving answers that it cannot be interrupted. That is a real
    // result, not a pass.
    assertNotNoSession(sinceInterrupt);

    if (after.length > 0) {
      throw new Error(
        `Agent kept posting ${after.length} time(s) more than 20s after \`!interrupt\`: ` +
          summarise(after)
      );
    }

    return `counting started in ${started.id}; silent for 45s after !interrupt`;
  });

export const SCENARIOS: Scenario[] = [greet, question, approval, interrupt];

/** Fixed-width summary of a run, printed at the end of the suite. */
export function formatResultsTable(results: ScenarioResult[]): string {
  const nameWidth = Math.max(8, ...results.map((result) => result.name.length));
  const rows = results.map((result) => {
    const status = result.ok ? 'PASS' : 'FAIL';
    const seconds = `${(result.durationMs / 1000).toFixed(1)}s`.padStart(7);
    return `  ${result.name.padEnd(nameWidth)}  ${status}  ${seconds}  ${result.details}`;
  });
  const passed = results.filter((result) => result.ok).length;
  return [
    '',
    `Scenario results (${passed}/${results.length} passed)`,
    `  ${'scenario'.padEnd(nameWidth)}  ────  ─────── details`,
    ...rows,
    '',
  ].join('\n');
}
