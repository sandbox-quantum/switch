import { expect } from 'vitest';
import { eventText } from '../clients/switch-client.ts';
import { WRITABLE, type FastScenario } from './scenario.ts';

/**
 * The bridge round trip with **no Switch Console and no model in the loop**:
 * the harness plays both the human and the agent.
 *
 * 1. create a room on the Mattermost bridge and confirm Switch provisions its
 *    channel with the agent in it;
 * 2. post `@agent …` as a human and confirm the addressed message reaches the
 *    agent-facing notification stream;
 * 3. `POST /agents/{id}/message` as the agent and confirm it lands back in the
 *    Mattermost channel as the agent's bot.
 *
 * If this passes and a provider-lane scenario fails, the fault is in the agent
 * session, not in Switch, the bridge, or the harness.
 */
export const mattermostRoundtrip: FastScenario = {
  header: {
    id: 'mattermost-roundtrip',
    covers: [
      'POST /gateway/rooms',
      'GET /agents/{agent_id}/notifications',
      'POST /agents/{agent_id}/message',
    ],
    needsProvider: false,
    environments: WRITABLE,
    owner: 'platform',
    requires: ['mattermost'],
  },
  async run({ fixtures, names, switchClient, mattermost, log }) {
    const agent = await fixtures.agent('loop');
    const bridged = await fixtures.mattermostRoom('room', [agent]);
    const bot = bridged.bots.get(agent.id)!;
    expect(bridged.room.externalChannelId).toBe(bridged.channel.id);
    expect(bridged.room.agentIds).toContain(agent.id);

    const marker = names.marker('loop');
    const sinceMs = Date.now();
    const posted = await mattermost!.post({
      channelId: bridged.channel.id,
      message: `@${agent.name} hello ${marker}`,
    });
    log(`posted ${posted.id} as ${bridged.human.username}`);

    // ── inbound: room -> Switch -> agent ────────────────────────────────────
    const inbound = await switchClient.waitForNotification(
      agent,
      (event) => eventText(event).includes(marker),
      120_000
    );
    expect(
      inbound.match,
      `the addressed message never reached the agent; saw ${JSON.stringify(inbound.seen).slice(0, 800)}`
    ).not.toBeNull();
    expect(inbound.match!.room_id).toBe(bridged.room.id);
    expect(inbound.match!.payload?.addressed).toBe(true);

    // ── outbound: agent -> Switch -> room ───────────────────────────────────
    const eventId = await switchClient.sendMessage(agent, bridged.room.id, `ack ${marker}`);
    expect(eventId).toBeTruthy();

    const outbound = await mattermost!.waitForPost({
      channelId: bridged.channel.id,
      fromUserId: bot.id,
      predicate: (post) => post.message.includes(`ack ${marker}`),
      sinceMs,
      deadlineMs: 120_000,
    });
    expect(
      outbound.match,
      `the agent's reply never appeared as bot ${bot.username}; channel said: ` +
        outbound.transcript.map((post) => `${post.user_id}: ${post.message}`).join(' | ')
    ).not.toBeNull();
  },
};
