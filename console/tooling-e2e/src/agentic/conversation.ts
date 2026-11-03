import { sleep, type MattermostPost } from '../clients/mattermost-client.ts';
import type { Harness } from '../provider/harness.ts';
import { isNoSessionNotice, isRuntimeStatusPost, turnStateOf } from '../provider/scenarios.ts';
import type { Turn } from './roles.ts';

/**
 * The human's side of the channel: post as the harness's Mattermost human,
 * then collect what the agent says back.
 *
 * Switch posts a status card for each turn, on the agent's bot account, and
 * edits it in place from `Working…` to how the turn ended; the agent's own
 * words arrive as separate posts beside it. A reply is finished when the card
 * says the turn ended, or, with no card, when the agent has been quiet for
 * `QUIET_MS`. Posts are read again on every poll, so what is kept is each
 * post's final text, not the first draft of it.
 *
 * The card and Switch's other commentary are not the agent speaking and are
 * left out of the transcript. A no-session notice, a turn that ended in an
 * error, or no reply at all ends the scenario.
 */

const QUIET_MS = 10_000;
const POLL_MS = 2_000;

export class NoReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoReplyError';
  }
}

/** Post a message nobody is addressed in. */
export async function postUnaddressed(harness: Harness, text: string): Promise<void> {
  await harness.mattermost.post({ channelId: harness.channel.id, message: text });
}

/** Post `@agent text` and return the agent's whole reply. */
export async function exchange(
  harness: Harness,
  text: string,
  replyDeadlineMs: number
): Promise<Turn> {
  const since = Date.now() - 1;
  await harness.mattermost.post({
    channelId: harness.channel.id,
    message: `@${harness.agent.name} ${text}`,
  });

  const deadline = Date.now() + replyDeadlineMs;
  const latest = new Map<string, MattermostPost>();
  let lastChangeMs = Date.now();
  for (;;) {
    for (const post of await harness.mattermost.postsFrom(
      harness.channel.id,
      harness.bot.id,
      since
    )) {
      if (isNoSessionNotice(post)) {
        throw new NoReplyError(`Switch says no session is attending the room: «${post.message}»`);
      }
      const before = latest.get(post.id);
      if (before === undefined || before.message !== post.message) {
        latest.set(post.id, post);
        lastChangeMs = Date.now();
      }
    }
    const posts = [...latest.values()].sort((a, b) => a.create_at - b.create_at);
    const said = posts.filter((post) => !isRuntimeStatusPost(post));
    const states = posts.map(turnStateOf).filter((state) => state !== null);
    const ended =
      states.length > 0 && states.every((state) => state !== 'queued' && state !== 'running');
    if (states.includes('error')) {
      throw new NoReplyError(
        `The agent's turn ended with an error. It said: ${said.map((post) => `«${post.message}»`).join(' ') || 'nothing'}`
      );
    }
    if (ended && said.length === 0) {
      throw new NoReplyError(
        `The agent's turn ended without a word in the room in answer to «${text}».`
      );
    }
    if (
      said.length > 0 &&
      (ended || (states.length === 0 && Date.now() - lastChangeMs >= QUIET_MS))
    ) {
      return { from: 'agent', text: said.map((post) => post.message).join('\n\n') };
    }
    if (Date.now() >= deadline) {
      throw new NoReplyError(
        said.length === 0
          ? `The agent did not reply within ${Math.round(replyDeadlineMs / 1000)} s to «${text}».`
          : `The agent's turn had not ended after ${Math.round(replyDeadlineMs / 1000)} s.`
      );
    }
    await sleep(POLL_MS);
  }
}
