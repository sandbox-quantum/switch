import { expect } from 'vitest';
import { eventText } from '../clients/switch-client.ts';
import { WRITABLE, type FastScenario } from './scenario.ts';

/**
 * The in-Console chat round trip with **no Switch Console and no model in the
 * loop**: the harness plays both the human and the agent.
 *
 * 1. open a group chat with the agent, as Switch Console does;
 * 2. post `@agent …` as the person and confirm the addressed message reaches
 *    the agent-facing notification stream;
 * 3. `POST /agents/{id}/message` as the agent and confirm it reads back in the
 *    chat as the agent's.
 *
 * If this passes and a provider-lane scenario fails, the fault is in the agent
 * session, not in Switch or the harness.
 */
export const consoleChatRoundtrip: FastScenario = {
  header: {
    id: 'console-chat-roundtrip',
    covers: [
      'POST /gateway/chats',
      'POST /gateway/chats/{room_id}/messages',
      'GET /gateway/chats/{room_id}/messages',
      'GET /agents/{agent_id}/notifications',
      'POST /agents/{agent_id}/message',
    ],
    lane: 'fast',
    environments: WRITABLE,
    owner: 'platform',
    requires: [],
  },
  async run({ fixtures, names, switchClient, chat, log }) {
    const agent = await fixtures.agent('loop');
    const { room, human } = await fixtures.consoleRoom('room', [agent]);
    expect(room.agentIds).toContain(agent.id);

    const marker = names.marker('loop');
    const posted = await chat.send(room.id, `@${agent.name} hello ${marker}`);
    log(`posted ${posted.messageId} as ${human.name}`);

    // ── inbound: chat -> Switch -> agent ────────────────────────────────────
    const inbound = await switchClient.waitForNotification(
      agent,
      (event) => eventText(event).includes(marker),
      120_000
    );
    expect(
      inbound.match,
      `the addressed message never reached the agent; saw ${JSON.stringify(inbound.seen).slice(0, 800)}`
    ).not.toBeNull();
    expect(inbound.match!.room_id).toBe(room.id);
    expect(inbound.match!.payload?.addressed).toBe(true);

    // ── outbound: agent -> Switch -> chat ───────────────────────────────────
    const eventId = await switchClient.sendMessage(agent, room.id, `ack ${marker}`);
    expect(eventId).toBeTruthy();

    const outbound = await chat.waitForMessage({
      roomId: room.id,
      fromAgentId: agent.id,
      predicate: (message) => message.body.includes(`ack ${marker}`),
      afterSeq: posted.seq,
      deadlineMs: 120_000,
    });
    expect(
      outbound.match,
      `the agent's reply never appeared in the chat; it said: ` +
        outbound.transcript.map((message) => `${message.sender.name}: ${message.body}`).join(' | ')
    ).not.toBeNull();
  },
};
