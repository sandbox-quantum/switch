import type { ChatMessage } from '../clients/console-chat-client.ts';
import { sleep } from '../clients/switch-client.ts';
import type { Harness } from '../provider/harness.ts';
import { isNoSessionNotice, isRuntimeStatusPost } from '../provider/scenarios.ts';
import type { Turn } from './roles.ts';

/**
 * The human's side of the room: post through the in-Console chat as the
 * harness's person, then collect what the agent says back.
 *
 * The room's activity carries a `turn` item for each turn the agent runs, with
 * its status (`queued`, `running`, then how it ended); the agent's own words
 * arrive as messages. A reply is finished when every turn started since the
 * message has ended, or, with no turn seen, when the agent has been quiet for
 * `QUIET_MS`. Messages are read again on every poll, so what is kept is each
 * message's final text.
 *
 * Switch's own commentary is not the agent speaking and is left out of the
 * transcript. A no-session notice, a turn that ended in an error, or no reply
 * at all ends the scenario.
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
  await harness.chat.send(harness.room.id, text);
}

/** The agent's turns in the room, by id, with their status. */
async function turns(harness: Harness): Promise<Map<string, string>> {
  const { items } = await harness.chat.activity(harness.room.id);
  return new Map(
    items
      .filter((item) => item.agentId === harness.agent.id && item.kind === 'turn')
      .map((item) => [item.turnId, item.status])
  );
}

/** Post `@agent text` and return the agent's whole reply. */
export async function exchange(
  harness: Harness,
  text: string,
  replyDeadlineMs: number
): Promise<Turn> {
  const before = new Set((await turns(harness)).keys());
  const sent = await harness.chat.send(harness.room.id, `@${harness.agent.name} ${text}`);

  const deadline = Date.now() + replyDeadlineMs;
  const latest = new Map<string, ChatMessage>();
  let lastChangeMs = Date.now();
  for (;;) {
    for (const post of await harness.chat.messagesAfter(harness.room.id, sent.seq)) {
      if (post.sender.agentId !== harness.agent.id) continue;
      if (isNoSessionNotice(post)) {
        throw new NoReplyError(`Switch says no session is attending the room: «${post.body}»`);
      }
      const seen = latest.get(post.messageId);
      if (seen === undefined || seen.body !== post.body) {
        latest.set(post.messageId, post);
        lastChangeMs = Date.now();
      }
    }
    const said = [...latest.values()]
      .sort((a, b) => a.seq - b.seq)
      .filter((post) => !isRuntimeStatusPost(post));
    const states = [...(await turns(harness))]
      .filter(([turnId]) => !before.has(turnId))
      .map(([, status]) => status);
    const ended =
      states.length > 0 && states.every((state) => state !== 'queued' && state !== 'running');
    if (states.includes('error')) {
      throw new NoReplyError(
        `The agent's turn ended with an error. It said: ${said.map((post) => `«${post.body}»`).join(' ') || 'nothing'}`
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
      return { from: 'agent', text: said.map((post) => post.body).join('\n\n') };
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
