import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeEnv } from './env.ts';
import { resolveSkip, setupHarness, teardownHarness, type Harness } from './harness.ts';
import type { MattermostPost } from './mattermost-client.ts';
import { eventText, sleep } from './switch-client.ts';

/**
 * Renaming and deleting an agent, end to end against a live Switch and
 * Mattermost, with no Switch Console and no model in the loop (the harness
 * plays the agent, as the loopback check does):
 *
 * 1. a rename from the gateway renames the agent's Mattermost bot in place,
 *    and the new name reaches the agent while the old one does not;
 * 2. `!rename-agent` from the chat does the same, for the person who owns the
 *    agent or administers the workspace;
 * 3. `!delete-agent`, confirmed, deletes it.
 *
 * The scenarios run in order and each builds on the last.
 */

let harness: Harness | null = null;
let skip: string | null = null;
let currentName = '';
let adminBotId = '';

beforeAll(async () => {
  const resolved = await resolveSkip();
  skip = resolved.skip;
  if (skip || !resolved.env) return;
  harness = await setupHarness(resolved.env, { autoSession: false, prefix: 'e2e-rn' });
  currentName = harness.agent.name;
  console.log(
    `identity: ${describeEnv(resolved.env)} agent=${harness.agent.name} (${harness.agent.id}) ` +
      `channel=${harness.channel.name} room=${harness.room.id}`
  );
  // The chat commands recognise the sender through the Switch user who linked
  // their chat account; the gateway admin the harness signs in as links it.
  await harness.switch.claimIdentity('mattermost', harness.human.id, harness.human.username);
  // A registered agent answers only its owner by default; the harness's human
  // is linked to the admin instead, so the mentions below need it open.
  await harness.switch.openAddressing(harness.agent.id);
}, 300_000);

afterAll(async () => {
  await teardownHarness(harness);
});

function renamed(suffix: string): string {
  // Same length as the original, so it stays inside Mattermost's cap, and
  // still `e2e-` prefixed so the cleanup script finds it after a failed run.
  return harness!.agent.name.replace(/^e2e-rn/, `e2e-r${suffix}`);
}

async function switchReply(sinceMs: number, pattern: RegExp): Promise<MattermostPost> {
  const h = harness!;
  if (!adminBotId) {
    const admin = await h.mattermost.waitForBotUser('switch-admin', 30_000);
    adminBotId = admin.id;
  }
  const found = await h.mattermost.waitForPost({
    channelId: h.channel.id,
    fromUserId: adminBotId,
    predicate: (post) => pattern.test(post.message),
    sinceMs,
    deadlineMs: 60_000,
  });
  if (!found.match) {
    throw new Error(
      `Switch never replied with ${pattern}. Transcript: ` +
        found.transcript.map((p) => `${p.user_id}: ${p.message}`).join(' | ')
    );
  }
  return found.match;
}

async function reachesAgent(name: string): Promise<boolean> {
  const h = harness!;
  const marker = `SWITCH_E2E_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  await h.mattermost.post({ channelId: h.channel.id, message: `@${name} ping ${marker}` });
  const seen = await h.switch.waitForNotification(
    h.agent,
    (event) => eventText(event).includes(marker),
    20_000
  );
  return seen.match !== null;
}

describe('renaming and deleting an agent', () => {
  it('a gateway rename renames the same Mattermost bot, and routing follows', async () => {
    if (skip) return void console.log(`SKIPPED: ${skip}`);
    const h = harness!;
    const newName = renamed('a');

    const result = await h.switch.renameAgent(h.agent.id, newName, 'Rename Check');

    expect(result.name).toBe(newName);
    expect(result.bridgeFailures).toEqual([]);
    const bot = await h.mattermost.waitForBotUser(newName, 30_000);
    expect(bot.id).toBe(h.bot.id);
    expect(await h.mattermost.findBotUser(currentName)).toBeNull();
    expect(await reachesAgent(newName)).toBe(true);
    expect(await reachesAgent(currentName)).toBe(false);
    currentName = newName;
  }, 300_000);

  it('!rename-agent from the chat renames it for the linked owner or admin', async () => {
    if (skip) return void console.log(`SKIPPED: ${skip}`);
    const h = harness!;
    const newName = renamed('b');
    const sinceMs = Date.now();

    await h.mattermost.post({
      channelId: h.channel.id,
      message: `!rename-agent @${currentName} ${newName}`,
    });

    await switchReply(sinceMs, /Renamed/);
    const bot = await h.mattermost.waitForBotUser(newName, 30_000);
    expect(bot.id).toBe(h.bot.id);
    expect(await reachesAgent(newName)).toBe(true);
    currentName = newName;
  }, 300_000);

  it('!delete-agent asks first, and deletes once confirmed', async () => {
    if (skip) return void console.log(`SKIPPED: ${skip}`);
    const h = harness!;
    let sinceMs = Date.now();

    await h.mattermost.post({ channelId: h.channel.id, message: `!delete-agent @${currentName}` });
    await switchReply(sinceMs, /To go ahead/);
    expect((await h.switch.listAgents()).some((a) => a.id === h.agent.id)).toBe(true);

    sinceMs = Date.now();
    await h.mattermost.post({
      channelId: h.channel.id,
      message: `!delete-agent ${currentName} confirm`,
    });
    await switchReply(sinceMs, /Deleted/);
    // The delete reaches the agent list once it has committed.
    for (let attempt = 0; attempt < 10; attempt++) {
      if (!(await h.switch.listAgents()).some((a) => a.id === h.agent.id)) break;
      await sleep(1_000);
    }
    expect((await h.switch.listAgents()).some((a) => a.id === h.agent.id)).toBe(false);
  }, 300_000);
});
