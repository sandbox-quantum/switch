import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sleep, type MattermostPost } from '../clients/mattermost-client.ts';
import type { ScenarioHeader } from '../core/scenario.ts';
import type { Harness } from './harness.ts';

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
 * Switch's own running commentary, posted **as the agent's bot** while a session
 * works: the activity ticker, the "needs your input" ping, the acknowledgement
 * of a control command.
 *
 * They have to be told apart from agent output for the same reason as the
 * no-session notices — the author is identical. A runtime status message is not evidence that an agent performed a task.
 */
const RUNTIME_STATUS_MARKERS = [
  '_working on it…_',
  '✓ done ·',
  '✓ input received',
  'needs your input.',
  'starting a session to handle this',
  'interrupted my current turn',
];

/**
 * Where a turn has got to, as the session renderer heads its status card with
 * it: one post per turn, edited in place from `Working…` to how the turn ended
 * (`TURN_STATE` in core/switch_core/bridges/collaboration/session/renderers).
 */
export type TurnState = 'queued' | 'running' | 'completed' | 'interrupted' | 'error';

const TURN_STATE_HEADINGS: readonly [TurnState, string][] = [
  ['queued', 'Queued.'],
  ['running', 'Working…'],
  ['completed', 'Turn complete.'],
  // A completed turn whose duration is known says how long it ran instead.
  ['completed', 'Worked for '],
  ['interrupted', 'Turn interrupted.'],
  ['error', 'Turn ended with an error.'],
];

/** The state a turn status card reports, or null when the post is not one. */
export function turnStateOf(post: MattermostPost): TurnState | null {
  const heading = /^\*\*([^*]+)\*\*/.exec(post.message.trimStart())?.[1] ?? '';
  return TURN_STATE_HEADINGS.find(([, text]) => heading.startsWith(text))?.[0] ?? null;
}

/** Whether a post is Switch narrating the session rather than the agent speaking. */
export function isRuntimeStatusPost(post: MattermostPost): boolean {
  if (turnStateOf(post) !== null) return true;
  const text = post.message.toLowerCase();
  return RUNTIME_STATUS_MARKERS.some((marker) => text.includes(marker));
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

/**
 * The handle a request card answers to: `A1` in "request `A1`". Switch renders
 * every relayed question and permission prompt as such a card, and an answer
 * is the handle followed by the option's number, typed as a plain message.
 */
export function requestHandle(text: string): string | null {
  return /request `([A-Za-z]+\d+)`/.exec(text)?.[1] ?? null;
}

/** Answer a request card, and return the moment just before the answer was posted. */
async function answerCard(harness: Harness, card: MattermostPost, option: number): Promise<number> {
  const handle = requestHandle(card.message);
  if (handle === null) throw new Error(`Post ${card.id} is not a request card: «${card.message}»`);
  const sinceMs = Date.now() - 1;
  await harness.mattermost.post({ channelId: harness.channel.id, message: `${handle} ${option}` });
  return sinceMs;
}

/**
 * The number a request card gives the option labelled `label`. The card numbers
 * options in the order the agent supplied them, which need not be the order it
 * was asked to list them in.
 */
export function optionNumber(card: string, label: string): number | null {
  const match = new RegExp(`(?:^|\\s)(\\d+)\\.\\s+${label}\\b`, 'i').exec(card);
  return match ? Number(match[1]) : null;
}

function chosenOption(card: MattermostPost): number {
  const option = optionNumber(card.message, CHOSEN);
  if (option === null) {
    throw new Error(`Request card ${card.id} offers no option '${CHOSEN}': «${card.message}»`);
  }
  return option;
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
    // Neither a no-session notice nor Switch's activity commentary is ever a
    // match, however permissive the caller's predicate — both are Switch
    // talking on the bot's account, not the agent.
    predicate: (post) =>
      !isNoSessionNotice(post) && !isRuntimeStatusPost(post) && params.predicate(post),
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
    const prose = harness.env.provider.questionMode === 'prose';
    const since = await ask(
      harness,
      prose
        ? 'before answering, ask me one clarifying multiple-choice question as an ordinary ' +
            `message: "Which color?", listing exactly the options ${CHOICES.join(', ')}. ` +
            'Wait for my answer, then reply with the single word I chose.'
        : 'before answering, ask me one clarifying multiple-choice question using your ' +
            'ask-the-user tool (the question tool, not a plain message): "Which color?" with ' +
            `exactly the options ${CHOICES.join(', ')}. Then reply with the single word I chose.`
    );

    const asked = await expectBotPost(harness, {
      since,
      record,
      // A native question is relayed as a request card numbering the options;
      // a plain-prose question also lists the three options, so the card is
      // what proves the relay path was taken — and is exactly what cannot be
      // required of a provider that offers SDK sessions no such tool.
      predicate: (post) =>
        CHOICES.every((choice) => lower(post).includes(choice)) &&
        (prose || (requestHandle(post.message) !== null && /\b2\.\s/.test(post.message))),
      describe: prose
        ? `a question listing the options ${CHOICES.join('/')}`
        : `a relayed question numbering the options ${CHOICES.join('/')}`,
    });

    // On the card where the relay is what reads the answer; by word where the
    // agent itself is. The card and the relay's acknowledgement name the choice
    // too, so the agent's own reply must be told apart from them either way.
    const answeredAt = prose
      ? await ask(harness, CHOSEN)
      : await answerCard(harness, asked, chosenOption(asked));
    const answer = await expectBotPost(harness, {
      since: answeredAt,
      record,
      predicate: (post) =>
        lower(post).includes(CHOSEN) &&
        requestHandle(post.message) === null &&
        !post.message.trimStart().startsWith('✅'),
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
        requestHandle(post.message) !== null &&
        APPROVAL_HINTS.some((hint) => lower(post).includes(hint)),
      describe: 'an approval card for the shell command',
    });

    const approvedAt = await answerCard(harness, prompt, 1);
    const done = await expectBotPost(harness, {
      since: approvedAt,
      record,
      predicate: (post) => lower(post).includes('done'),
      describe: "a 'done' reply after the command was approved",
    });

    return `prompted in ${prompt.id}, completed in ${done.id}`;
  });

// ── interrupt ────────────────────────────────────────────────────────────────

/** Only the command's exact marker proves execution began. */
export function isStartMarker(text: string): boolean {
  return text === 'SWITCH_INTERRUPT_STARTED';
}

async function markerContents(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/** A real local command must start and then be cancelled before its final write. */
export const interrupt: Scenario = (harness) =>
  scenario('interrupt', async (record) => {
    const dir = harness.env.provider.agentRepoDir;
    if (!dir)
      throw new Error('The interrupt scenario requires SWITCH_E2E_AGENT_DIR on this machine.');
    const stem = `interrupt-${harness.runId}-${Date.now()}`;
    const startedFile = path.join(dir, `${stem}-started.txt`);
    const finishedFile = path.join(dir, `${stem}-finished.txt`);
    const command = `printf SWITCH_INTERRUPT_STARTED > ${stem}-started.txt; sleep 90; printf SWITCH_INTERRUPT_FINISHED > ${stem}-finished.txt`;
    const since = await ask(
      harness,
      `Run this exact shell command for a bounded cancellation test: \`${command}\`. Wait for completion before replying. Do not create these files with another tool.`
    );
    const permission = await expectBotPost(harness, {
      since,
      record,
      predicate: (post) =>
        requestHandle(post.message) !== null &&
        APPROVAL_HINTS.some((hint) => lower(post).includes(hint)),
      describe: 'an approval card for the cancellation command',
    });
    await answerCard(harness, permission, 1);
    const deadline = Date.now() + 60_000;
    while (!isStartMarker((await markerContents(startedFile)) ?? '')) {
      if (Date.now() > deadline)
        throw new Error('The cancellation command did not write its start marker.');
      await sleep(500);
    }
    const startedAt = Date.now();
    await harness.mattermost.post({
      channelId: harness.channel.id,
      message: `!interrupt @${harness.agent.name}`,
    });
    // Wait beyond the command's complete lifetime; an un-cancelled sleep must finish.
    while (Date.now() - startedAt < 95_000) {
      if ((await markerContents(finishedFile)) !== null)
        throw new Error('The interrupted command wrote its completion marker.');
      await sleep(1_000);
    }
    const posts = await harness.mattermost.postsSince(harness.channel.id, since);
    record(posts);
    assertNotNoSession(posts);
    if ((await markerContents(finishedFile)) !== null)
      throw new Error('The interrupted command completed.');
    return 'command start confirmed; completion marker absent after 95s';
  });

/**
 * A provider-lane scenario: its header, and the function that drives it. All of
 * them share one agent and one channel, set up once per run.
 */
export interface ProviderScenario {
  header: ScenarioHeader;
  run: Scenario;
}

/** Writes to a room, so never prod. */
const PROVIDER_ENVIRONMENTS: ScenarioHeader['environments'] = [
  'ephemeral',
  'local',
  'dev',
  'staging',
];

function providerHeader(
  id: string,
  covers: string[],
  requires: ScenarioHeader['requires']
): ScenarioHeader {
  return {
    id,
    covers,
    lane: 'provider',
    environments: PROVIDER_ENVIRONMENTS,
    owner: 'console',
    requires: ['mattermost', ...requires],
  };
}

export const SCENARIOS: readonly ProviderScenario[] = [
  { header: providerHeader('greet', ['connect_to_room', 'post_message'], []), run: greet },
  { header: providerHeader('question', ['connect_to_room', 'post_message'], []), run: question },
  { header: providerHeader('approval', ['connect_to_room', 'post_message'], []), run: approval },
  {
    header: providerHeader('interrupt', ['connect_to_room', 'post_message'], ['agent-dir']),
    run: interrupt,
  },
];

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
