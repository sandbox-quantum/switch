import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeEnv } from './env.ts';
import { resolveSkip, setupHarness, teardownHarness, type Harness } from './harness.ts';
import { eventText } from './switch-client.ts';

/**
 * The harness's own plumbing, proved against a live stack with **no Switch
 * Console and no model in the loop**: the harness plays both parts.
 *
 * 1. register an agent, create a channel, add the agent's bot to it, and confirm
 *    Switch provisions a room for that channel;
 * 2. post `@agent …` as a human and confirm the addressed message reaches the
 *    agent-facing notification stream;
 * 3. `POST /agents/{id}/message` as the agent and confirm it lands back in the
 *    Mattermost channel as the bot.
 *
 * If this file passes and `run.integration.test.ts` fails, the fault is in the
 * console session, not in Switch, the bridge, or the harness.
 */

let harness: Harness | null = null;
let skip: string | null = null;

beforeAll(async () => {
  const resolved = await resolveSkip();
  skip = resolved.skip;
  if (skip || !resolved.env) return;
  // auto_session off: nothing is expected to spawn a session — this test *is*
  // the agent, so an auto_session profile would only invite the operator's
  // console to fight it for the room.
  harness = await setupHarness(resolved.env, { autoSession: false, prefix: 'e2e-loop' });
  console.log(
    `loopback: ${describeEnv(resolved.env)} agent=${harness.agent.name} (${harness.agent.id}) ` +
      `channel=${harness.channel.name} (${harness.channel.id}) room=${harness.room.id}`
  );
}, 300_000);

afterAll(async () => {
  await teardownHarness(harness);
});

describe('Switch <-> Mattermost loopback', () => {
  it('provisions a Switch room when the agent bot joins a Mattermost channel', () => {
    if (skip) return void console.log(`SKIPPED: ${skip}`);
    expect(harness).not.toBeNull();
    expect(harness!.room.externalChannelId).toBe(harness!.channel.id);
    expect(harness!.room.agentIds).toContain(harness!.agent.id);
  });

  it('delivers an addressed channel message to the agent, and the agent reply back to the channel', async () => {
    if (skip) return void console.log(`SKIPPED: ${skip}`);
    const h = harness!;
    const marker = `SWITCH_E2E_${h.runId.toUpperCase()}`;

    const sinceMs = Date.now();
    const posted = await h.mattermost.post({
      channelId: h.channel.id,
      message: `@${h.agent.name} hello ${marker}`,
    });
    console.log(`loopback: posted ${posted.id} as ${h.human.username}`);

    // ── inbound: room -> Switch -> agent ────────────────────────────────────
    const inbound = await h.switch.waitForNotification(
      h.agent,
      (event) => eventText(event).includes(marker),
      120_000
    );
    if (!inbound.match) {
      throw new Error(
        `Addressed message never reached the agent's notification stream. Saw: ${JSON.stringify(
          inbound.seen
        ).slice(0, 1000)}`
      );
    }
    expect(inbound.match.room_id).toBe(h.room.id);
    console.log(
      `loopback: agent received event type=${inbound.match.type} room=${inbound.match.room_id}`
    );

    // ── outbound: agent -> Switch -> room ───────────────────────────────────
    const reply = `ack ${marker}`;
    const eventId = await h.switch.sendMessage(h.agent, h.room.id, reply);
    expect(eventId).toBeTruthy();

    const outbound = await h.mattermost.waitForPost({
      channelId: h.channel.id,
      fromUserId: h.bot.id,
      predicate: (post) => post.message.includes(marker),
      sinceMs,
      deadlineMs: 120_000,
    });
    if (!outbound.match) {
      throw new Error(
        `Agent reply never appeared in Mattermost as bot ${h.bot.username}. Transcript: ` +
          outbound.transcript.map((p) => `${p.user_id}: ${p.message}`).join(' | ')
      );
    }
    console.log(
      `loopback: bot post ${outbound.match.id} (matrix event ${eventId}) — round trip closed`
    );
  }, 400_000);
});
