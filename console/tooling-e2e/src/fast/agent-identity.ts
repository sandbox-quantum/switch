import { expect } from 'vitest';
import type { ConsoleChatClient } from '../clients/console-chat-client.ts';
import {
  eventText,
  sleep,
  type RegisteredAgent,
  type SwitchClient,
} from '../clients/switch-client.ts';
import { WRITABLE, type FastScenario } from './scenario.ts';

/**
 * Renaming and deleting an agent, with the harness playing both the human and
 * the agent in an in-Console chat:
 *
 * 1. a rename from the gateway takes effect, so the new name reaches the agent
 *    and the old one does not;
 * 2. `!rename-agent` typed in the chat does the same, for the person who owns
 *    the agent or administers the workspace;
 * 3. `!delete-agent`, confirmed, deletes it.
 *
 * Each step builds on the last.
 */
export const agentIdentity: FastScenario = {
  header: {
    id: 'agent-identity',
    covers: ['PUT /gateway/agents/{agent_id}/name'],
    lane: 'fast',
    environments: WRITABLE,
    owner: 'platform',
    requires: [],
  },
  async run({ fixtures, names, switchClient, chat, log }) {
    const agent = await fixtures.agent('id');
    const { room } = await fixtures.consoleRoom('room', [agent]);
    const reaches = (name: string, label: string): Promise<boolean> =>
      reachesAgent(switchClient, chat, names.marker(label), agent, room.id, name);

    // ── a rename from the gateway ───────────────────────────────────────────
    const first = names.name('ida');
    const result = await switchClient.renameAgent(agent.id, first, 'Rename Check');
    expect(result.name).toBe(first);
    expect(result.bridgeFailures).toEqual([]);
    expect(await reaches(first, 'new-a'), `@${first} did not reach the renamed agent`).toBe(true);
    expect(await reaches(agent.name, 'old-a'), `@${agent.name} still reached the agent`).toBe(
      false
    );
    log(`renamed ${agent.name} to ${first} from the gateway`);

    // ── !rename-agent from the chat ─────────────────────────────────────────
    const second = names.name('idb');
    await command(chat, room.id, `!rename-agent @${first} ${second}`, /Renamed/);
    expect(await reaches(second, 'new-b'), `@${second} did not reach the renamed agent`).toBe(true);
    log(`renamed ${first} to ${second} from the chat`);

    // ── !delete-agent, then confirmed ───────────────────────────────────────
    await command(chat, room.id, `!delete-agent @${second}`, /To go ahead/);
    expect((await switchClient.listAgents()).some((a) => a.id === agent.id)).toBe(true);

    await command(chat, room.id, `!delete-agent ${second} confirm`, /Deleted/);
    // The delete reaches the agent list once it has committed.
    for (let attempt = 0; attempt < 10; attempt++) {
      if (!(await switchClient.listAgents()).some((a) => a.id === agent.id)) break;
      await sleep(1_000);
    }
    expect((await switchClient.listAgents()).some((a) => a.id === agent.id)).toBe(false);
    fixtures.removed(agent);
  },
};

/** Type `text` into the chat and wait for Switch's reply matching `pattern`. */
async function command(
  chat: ConsoleChatClient,
  roomId: string,
  text: string,
  pattern: RegExp
): Promise<void> {
  const sent = await chat.send(roomId, text);
  const until = Date.now() + 60_000;
  for (;;) {
    const transcript = await chat.messagesAfter(roomId, sent.seq);
    if (transcript.some((message) => pattern.test(message.body))) return;
    if (Date.now() >= until) {
      throw new Error(
        `Switch never replied to ${text} with ${pattern}. Transcript: ` +
          transcript.map((m) => `${m.sender.name}: ${m.body}`).join(' | ')
      );
    }
    await sleep(1_000);
  }
}

async function reachesAgent(
  switchClient: SwitchClient,
  chat: ConsoleChatClient,
  marker: string,
  agent: RegisteredAgent,
  roomId: string,
  name: string
): Promise<boolean> {
  await chat.send(roomId, `@${name} ping ${marker}`);
  const seen = await switchClient.waitForNotification(
    agent,
    (event) => eventText(event).includes(marker),
    20_000
  );
  return seen.match !== null;
}
