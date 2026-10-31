import { expect } from 'vitest';
import type { ChatMessage, ConsoleChatClient } from '../clients/console-chat-client.ts';
import {
  eventText,
  sleep,
  type AgentEvent,
  type RegisteredAgent,
  type SwitchClient,
} from '../clients/switch-client.ts';
import type { ConsoleRoom } from '../fixtures/fixtures.ts';
import type { FastScenario } from './scenario.ts';

const FLAG = 'follow_the_conversation';
const DEADLINE_MS = 60_000;

/** The window the server was started with: set by the ephemeral stack, which starts it. */
function followWindowMs(): number {
  const raw = process.env.SWITCH_E2E_FOLLOW_WINDOW_SECONDS;
  const seconds = Number(raw);
  if (raw === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(
      `SWITCH_E2E_FOLLOW_WINDOW_SECONDS must name the server's FOLLOW_THE_CONVERSATION_WINDOW_SECONDS (got '${raw}').`
    );
  }
  return seconds * 1000;
}

/**
 * Follow the conversation: a person's untagged message reaches the agent they
 * are talking to. It does when it continues an exchange the agent has just
 * answered, or replies in a thread the agent spoke in last. It does not when
 * another agent spoke in between, or when the exchange has gone quiet for longer
 * than the window. A message from an agent never follows anyone.
 *
 * Each "does not" is shown by an `@agent` message posted after it: the agent's
 * notifications arrive in order, so if the untagged one had reached it, it
 * would have arrived first.
 *
 * Ephemeral only: the flag is server-wide, and the window has to be short
 * enough to wait out.
 */
export const followUps: FastScenario = {
  header: {
    id: 'follow-ups',
    covers: ['GET /agents/{agent_id}/notifications', 'POST /agents/{agent_id}/message'],
    lane: 'fast',
    environments: ['ephemeral'],
    owner: 'platform',
    requires: [],
  },
  async run({ fixtures, names, switchClient, chat, log }) {
    const flags = await switchClient.enabledFeatureFlags();
    if (!flags.has(FLAG)) {
      throw new Error(
        `The server does not have '${FLAG}' on; the ephemeral stack starts it with it.`
      );
    }
    const windowMs = followWindowMs();
    const a = await fixtures.agent('fa');
    const b = await fixtures.agent('fb');
    const room = await fixtures.consoleRoom('ftc', [a, b]);
    const talk = new Exchange(switchClient, chat, room);

    // A channel follow-up: the person goes on, untagged, after the agent answered.
    const q1 = names.marker('q1');
    await talk.human(`@${a.name} first question ${q1}`, null);
    await talk.notified(a, q1, 'a mention', []);
    const answer = await talk.answer(a, `first answer ${names.marker('a1')}`);
    const q2 = names.marker('q2');
    await talk.human(`and a second one ${q2}`, null);
    const followed = await talk.notified(a, q2, 'an untagged channel follow-up', []);
    expect(followed.payload?.addressed).toBe(true);
    expect(followed.payload?.thread_id ?? null).toBeNull();

    // A thread follow-up: a reply under the agent's answer, in a thread it spoke in last.
    const q3 = names.marker('q3');
    await talk.human(`why so ${q3}`, answer.message.messageId);
    const threaded = await talk.notified(a, q3, 'an untagged reply in its thread', []);
    expect(threaded.payload?.thread_id).toBe(answer.eventId);

    // Another agent speaks: its message follows no one, and ends the person's exchange.
    const fyi = names.marker('fyi');
    await talk.answer(b, `for your information ${fyi}`);
    const q4 = names.marker('q4');
    await talk.human(`and a third one ${q4}`, null);
    const q5 = names.marker('q5');
    await talk.human(`@${a.name} back to you ${q5}`, null);
    await talk.notified(a, q5, 'a mention', [fyi, q4]);
    const history = await switchClient.roomHistory(a, room.room.id, 20);
    expect(history.map((event) => event.body).some((body) => body.includes(fyi))).toBe(true);

    // The exchange goes quiet for longer than the window.
    await talk.answer(a, `answered ${names.marker('a5')}`);
    log(`waiting out the ${windowMs / 1000}s follow-up window`);
    await sleep(windowMs + 5_000);
    const q6 = names.marker('q6');
    await talk.human(`one more thing ${q6}`, null);
    const q7 = names.marker('q7');
    await talk.human(`@${a.name} last one ${q7}`, null);
    await talk.notified(a, q7, 'a mention', [q6]);

    // b was never addressed, and is not followed: nothing above reached it.
    const strays = (await switchClient.pollNotifications(b, 2)).filter((event) =>
      [q1, q2, q3, q4, q5, q6, q7].some((marker) => eventText(event).includes(marker))
    );
    expect(strays.map(eventText), 'messages that reached the agent nobody talked to').toEqual([]);
  },
};

/** One person and two agents talking in an in-Console chat. */
class Exchange {
  private readonly switchClient: SwitchClient;
  private readonly chat: ConsoleChatClient;
  private readonly room: ConsoleRoom;

  constructor(switchClient: SwitchClient, chat: ConsoleChatClient, room: ConsoleRoom) {
    this.switchClient = switchClient;
    this.chat = chat;
    this.room = room;
  }

  /** Post as the person: top-level, or under `rootId` in a thread. */
  async human(message: string, rootId: string | null): Promise<void> {
    await this.chat.send(this.room.room.id, message, rootId);
  }

  /** Post top-level as the agent, and wait for the message to read back in the chat. */
  async answer(
    agent: RegisteredAgent,
    text: string
  ): Promise<{ eventId: string; message: ChatMessage }> {
    const eventId = await this.switchClient.sendMessage(agent, this.room.room.id, text);
    const { match, transcript } = await this.chat.waitForMessage({
      roomId: this.room.room.id,
      fromAgentId: agent.id,
      predicate: (message) => message.body.includes(text),
      afterSeq: 0,
      deadlineMs: DEADLINE_MS,
    });
    if (match === null) {
      throw new Error(
        `${agent.name}'s '${text}' never reached the chat; it said: ` +
          transcript.map((message) => message.body).join(' | ')
      );
    }
    return { eventId, message: match };
  }

  /**
   * Wait for `marker` to reach the agent, and fail if any of `notBefore` did
   * first.
   */
  async notified(
    agent: RegisteredAgent,
    marker: string,
    what: string,
    notBefore: string[]
  ): Promise<AgentEvent> {
    const { match, seen } = await this.switchClient.waitForNotification(
      agent,
      (event) => eventText(event).includes(marker),
      DEADLINE_MS
    );
    expect(
      match,
      `${what} (${marker}) never reached ${agent.name}; saw ${seen.map(eventText).join(' | ')}`
    ).not.toBeNull();
    const early = seen.filter((event) => notBefore.some((text) => eventText(event).includes(text)));
    expect(early.map(eventText), `reached ${agent.name} though it should not have`).toEqual([]);
    return match!;
  }
}
