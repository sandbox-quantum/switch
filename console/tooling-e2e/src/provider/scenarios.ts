import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import {
  MattermostClient,
  sleep,
  type MattermostPost,
  type MattermostUser,
} from '../clients/mattermost-client.ts';
import { OWNER_ONLY, TemplateRefusal, type TemplateRun } from '../clients/switch-client.ts';
import type { NameScope } from '../core/run.ts';
import type { ScenarioHeader } from '../core/scenario.ts';
import { IssuedSecrets } from '../core/secrets.ts';
import { waitForBridgeReady } from '../fixtures/fixtures.ts';
import {
  AGENT_INSTRUCTIONS,
  CLAUDE_MODEL,
  NOT_READY_CODES,
  PLACEMENT_DEADLINE_MS,
  PROVIDER_BY_AGENT_TYPE,
  type Harness,
} from './harness.ts';

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

/** `names` names whatever a scenario makes beyond the shared agent and channel. */
export type Scenario = (harness: Harness, names: NameScope) => Promise<ScenarioResult>;

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
  mattermost: MattermostClient,
  params: {
    /** The channel to watch, and the bot whose posts count. */
    where: { channelId: string; botId: string };
    since: number;
    predicate: (post: MattermostPost) => boolean;
    describe: string;
    deadlineMs?: number;
    record: (posts: MattermostPost[]) => void;
  }
): Promise<MattermostPost> {
  const { match, transcript } = await mattermost.waitForPost({
    channelId: params.where.channelId,
    fromUserId: params.where.botId,
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

/** The shared channel, and the shared agent's bot. */
function sharedRoom(harness: Harness): { channelId: string; botId: string } {
  return { channelId: harness.channel.id, botId: harness.bot.id };
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
    const match = await expectBotPost(harness.mattermost, {
      where: sharedRoom(harness),
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

    const asked = await expectBotPost(harness.mattermost, {
      where: sharedRoom(harness),
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
    const answer = await expectBotPost(harness.mattermost, {
      where: sharedRoom(harness),
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

    const prompt = await expectBotPost(harness.mattermost, {
      where: sharedRoom(harness),
      since,
      record,
      predicate: (post) =>
        requestHandle(post.message) !== null &&
        APPROVAL_HINTS.some((hint) => lower(post).includes(hint)),
      describe: 'an approval card for the shell command',
    });

    const approvedAt = await answerCard(harness, prompt, 1);
    const done = await expectBotPost(harness.mattermost, {
      where: sharedRoom(harness),
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
    const permission = await expectBotPost(harness.mattermost, {
      where: sharedRoom(harness),
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

// ── card answered by someone who may not ─────────────────────────────────────

/**
 * Answering a request card takes the same permission as addressing the agent.
 * With the agent open only to its owner, a person who is not the owner answers
 * the card and is told the answer did not land, and the command does not run;
 * the owner answers it and the command runs.
 *
 * The second person signs up on the spot, so this runs only where Mattermost
 * lets anyone sign up: the throwaway stack and a local one. On both, the person
 * the harness posts as is the identity the admin who owns the agent claimed.
 */
/** How long a refused answer is given to run the command anyway, before the owner answers. */
const REFUSED_QUIET_MS = 20_000;

export const cardAnswerRefused: Scenario = (harness, names) =>
  scenario('card-answer-refused', async (record) => {
    const mattermostEnv = harness.env.mattermost;
    if (mattermostEnv === null) throw new Error('This scenario needs Mattermost.');
    const secrets = new IssuedSecrets(harness.env.secretsFile);
    const username = names.name('other');
    const password = `E2e-${randomBytes(18).toString('base64url')}`;
    secrets.record(password);
    const other = await MattermostClient.signUp(mattermostEnv, harness.env.environment, {
      username,
      email: `${username}@example.com`,
      password,
    });
    secrets.record(other.token);
    try {
      return await refuseThenApprove(harness, record, other);
    } finally {
      await other.client.leave(other.user.id);
    }
  });

async function refuseThenApprove(
  harness: Harness,
  record: (posts: MattermostPost[]) => void,
  other: { client: MattermostClient; user: MattermostUser }
): Promise<string> {
  const mattermostEnv = harness.env.mattermost!;
  const username = other.user.username;
  const team = await harness.mattermost.findTeam(mattermostEnv.team);
  await other.client.joinTeam(team.id, other.user.id);
  await harness.mattermost.addUserToChannel(harness.channel.id, other.user.id);

  await harness.switch.setAddressingPolicy(harness.agent.id, OWNER_ONLY);
  try {
    const file = `refused-${harness.runId}.txt`;
    const since = await ask(
      harness,
      `run the shell command \`echo ${OK_MARKER} > ${file}\` and then reply with the single word done`
    );
    const card = await expectBotPost(harness.mattermost, {
      where: sharedRoom(harness),
      since,
      record,
      predicate: (post) =>
        requestHandle(post.message) !== null &&
        APPROVAL_HINTS.some((hint) => lower(post).includes(hint)),
      describe: 'an approval card for the shell command',
    });
    const handle = requestHandle(card.message)!;
    const thread = card.root_id === '' ? card.id : card.root_id;

    const refusedAt = Date.now() - 1;
    await other.client.post({ channelId: harness.channel.id, message: `${handle} 1` });
    // Said by the bridge's own admin account, whatever it is called here.
    const isNotice = (post: MattermostPost): boolean =>
      post.root_id === thread &&
      post.message.includes(`answer to ${handle} did not land`) &&
      post.message.includes('may not address this agent');
    let notice: MattermostPost | undefined;
    const until = Date.now() + 60_000;
    while (notice === undefined && Date.now() < until) {
      const posts = await harness.mattermost.postsSince(harness.channel.id, refusedAt);
      record(posts);
      notice = posts.find(isNotice);
      if (notice === undefined) await sleep(2_000);
    }
    if (notice === undefined) {
      const seen = await harness.mattermost.postsSince(harness.channel.id, refusedAt);
      throw new Error(
        `${username}'s answer to ${handle} was not refused in the card's thread. Channel said: ${summarise(seen)}`
      );
    }
    if (notice.user_id === other.user.id || notice.user_id === harness.human.id) {
      throw new Error(`The refusal notice was posted by a person, not by Switch: ${notice.id}`);
    }
    // A refused answer must not run the command: give it time to, if it would.
    const quietUntil = Date.now() + REFUSED_QUIET_MS;
    while (Date.now() < quietUntil) {
      const ranEarly = (
        await harness.mattermost.postsFrom(harness.channel.id, harness.bot.id, refusedAt)
      ).filter(
        (post) =>
          !isRuntimeStatusPost(post) && !isNoSessionNotice(post) && lower(post).includes('done')
      );
      if (ranEarly.length > 0) {
        record(ranEarly);
        throw new Error('The command ran on the answer of someone who may not address the agent.');
      }
      await sleep(2_000);
    }

    const approvedAt = await answerCard(harness, card, 1);
    const done = await expectBotPost(harness.mattermost, {
      where: sharedRoom(harness),
      since: approvedAt,
      record,
      predicate: (post) => lower(post).includes('done'),
      describe: "a 'done' reply after the owner approved the command",
    });
    return `refused in ${notice.id}, approved by the owner, completed in ${done.id}`;
  } finally {
    await harness.switch.openAddressing(harness.agent.id);
  }
}

// ── template ─────────────────────────────────────────────────────────────────

/**
 * Run a template, retrying while the controller is not ready to take its agent:
 * a refused run creates nothing, so running it again is safe.
 */
async function runTemplate(harness: Harness, template: string): Promise<TemplateRun> {
  const until = Date.now() + PLACEMENT_DEADLINE_MS;
  for (;;) {
    try {
      return await harness.switch.runTemplateDocument({ template, templateName: 'e2e-template' });
    } catch (error) {
      const waiting =
        error instanceof TemplateRefusal &&
        error.problems.length > 0 &&
        error.problems.every((problem) => NOT_READY_CODES.has(problem.code));
      if (!waiting || Date.now() > until) throw error;
      await sleep(3_000);
    }
  }
}

/**
 * A template creates a managed agent on the controller and a room on the
 * Mattermost bridge with it in it, and the agent answers there: what a person
 * using a template from Switch Console gets.
 */
export const templateAgent: Scenario = (harness, names) =>
  scenario('template-agent', async (record) => {
    const controllerId = harness.env.provider.controllerId;
    if (controllerId === null) throw new Error('This scenario needs an agent controller.');
    const provider = PROVIDER_BY_AGENT_TYPE[harness.env.provider.agentType];
    const about = `Switch end-to-end harness (run ${harness.runId}). Safe to delete.`;
    const agentName = names.name('tpl');
    const bridge = await harness.switch.defaultBridge('mattermost');
    const template = stringify({
      version: 1,
      agent: {
        name: agentName,
        description: about,
        instructions: AGENT_INSTRUCTIONS,
        provider,
        machine: controllerId,
        // The machine's own workspace for the agent, when the run names none.
        directory: harness.env.provider.agentRepoDir ?? '{$agents_dir}/{agent}',
        ...(provider === 'claude' ? { model: CLAUDE_MODEL } : {}),
        auto_mode: false,
        auto_approve: false,
        addressing: 'anyone',
      },
      room: {
        name: names.name('troom'),
        description: about,
        bridge: bridge.displayName,
        // The witness reads the room for the bridge probe, as in the shared room.
        agents: ['{agent}', harness.witness.name],
        users: [harness.human.username],
      },
    });

    const run = await runTemplate(harness, template);
    const undo: { label: string; run: () => Promise<void> }[] = [];
    for (const made of run.created_agents) {
      undo.push({
        label: `agent ${made.name} (${made.agent_id})`,
        run: () => harness.switch.deleteAgentByName(made.name),
      });
    }
    const roomId = run.room.room_id;
    undo.push({
      label: `room ${run.room.room_name} (${roomId})`,
      run: async () => {
        const { externalChannelId } = await harness.switch.getRoom(roomId);
        await harness.switch.deleteRoom(roomId);
        if (externalChannelId === null) return;
        const left = await harness.mattermost.getChannel(externalChannelId);
        if (!left.delete_at) await harness.mattermost.archiveChannel(externalChannelId);
      },
    });

    let failed = false;
    try {
      const room = await harness.switch.getRoom(roomId);
      const channelId = room.externalChannelId;
      if (run.created_agents.length !== 1) {
        throw new Error(`The template made ${run.created_agents.length} agents, not one.`);
      }
      const made = run.created_agents[0]!;
      if (made.name !== agentName || made.machine.id !== controllerId || !made.listening) {
        throw new Error(`The template's agent is not the one asked for: ${JSON.stringify(made)}`);
      }
      if (channelId === null)
        throw new Error(`The template's room ${room.id} has no Mattermost channel.`);
      const bot = await harness.mattermost.waitForBotUser(agentName, 60_000);
      const channel = await harness.mattermost.getChannel(channelId);
      // A post made before the new bot's socket is up is dropped.
      await waitForBridgeReady({
        switchClient: harness.switch,
        mattermost: harness.mattermost,
        agent: harness.witness,
        room,
        channel,
        runId: harness.runId,
      });
      const marker = `${OK_MARKER}_TPL`;
      const since = Date.now() - 1;
      await harness.mattermost.post({
        channelId,
        message: `@${agentName} reply with exactly ${marker} and nothing else`,
      });
      const reply = await expectBotPost(harness.mattermost, {
        where: { channelId, botId: bot.id },
        since,
        record,
        predicate: (post) => post.message.includes(marker),
        describe: `a reply containing ${marker} from the template's agent`,
      });
      return `${agentName} on ${made.machine.name} replied in post ${reply.id}`;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      const left: string[] = [];
      for (const step of undo.reverse()) {
        try {
          await step.run();
        } catch (error) {
          left.push(`${step.label}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (left.length > 0) {
        const message = `could not remove what the template made — delete it by hand: ${left.join('; ')}`;
        if (failed) console.warn(message);
        else throw new Error(message);
      }
    }
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
  {
    // A second person signs up, which only a throwaway or local Mattermost lets anyone do.
    header: {
      ...providerHeader(
        'card-answer-refused',
        ['PUT /gateway/agents/{agent_id}/addressing-policy'],
        []
      ),
      environments: ['ephemeral', 'local'],
    },
    run: cardAnswerRefused,
  },
  {
    header: providerHeader(
      'template-agent',
      ['POST /gateway/rooms/from-template-document'],
      ['controller']
    ),
    run: templateAgent,
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
