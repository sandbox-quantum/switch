import { expect } from "vitest";
import type {
  MattermostClient,
  MattermostPost,
} from "../clients/mattermost-client.ts";
import {
  eventText,
  sleep,
  type RegisteredAgent,
  type SwitchClient,
} from "../clients/switch-client.ts";
import { WRITABLE, type FastScenario } from "./scenario.ts";

/**
 * Renaming and deleting an agent on the Mattermost bridge, with the harness
 * playing both the human and the agent:
 *
 * 1. a rename from the gateway renames the agent's Mattermost bot in place,
 *    and the new name reaches the agent while the old one does not;
 * 2. `!rename-agent` from the chat does the same, for the person who owns the
 *    agent or administers the workspace;
 * 3. `!delete-agent`, confirmed, deletes it.
 *
 * Each step builds on the last.
 */
export const agentIdentity: FastScenario = {
  header: {
    id: "agent-identity",
    covers: [
      "PUT /gateway/agents/{agent_id}/name",
      "POST /gateway/collaborations/{bridge_id}/identities",
    ],
    lane: "fast",
    environments: WRITABLE,
    owner: "platform",
    requires: ["mattermost"],
  },
  async run({ fixtures, names, switchClient, mattermost, log }) {
    const mm = mattermost!;
    const agent = await fixtures.agent("id");
    const bridged = await fixtures.mattermostRoom("room", [agent]);
    const bot = bridged.bots.get(agent.id)!;
    const channelId = bridged.channel.id;
    // The chat commands recognise the sender through the Switch user who linked
    // their chat account; the gateway admin the harness signs in as links it.
    await switchClient.claimIdentity(
      "mattermost",
      bridged.human.id,
      bridged.human.username,
    );
    const admin = await mm.waitForBotUser("switch-admin", 30_000);
    const reaches = (name: string, label: string): Promise<boolean> =>
      reachesAgent(
        switchClient,
        mm,
        names.marker(label),
        agent,
        channelId,
        name,
      );

    // ── a rename from the gateway ───────────────────────────────────────────
    const first = names.name("ida");
    const result = await switchClient.renameAgent(
      agent.id,
      first,
      "Rename Check",
    );
    expect(result.name).toBe(first);
    expect(result.bridgeFailures).toEqual([]);
    expect((await mm.waitForBotUser(first, 30_000)).id).toBe(bot.id);
    expect(await mm.findBotUser(agent.name)).toBeNull();
    expect(
      await reaches(first, "new-a"),
      `@${first} did not reach the renamed agent`,
    ).toBe(true);
    expect(
      await reaches(agent.name, "old-a"),
      `@${agent.name} still reached the agent`,
    ).toBe(false);
    log(`renamed ${agent.name} to ${first} from the gateway`);

    // ── !rename-agent from the chat ─────────────────────────────────────────
    const second = names.name("idb");
    let sinceMs = Date.now();
    await mm.post({ channelId, message: `!rename-agent @${first} ${second}` });
    await switchReply(mm, channelId, admin.id, sinceMs, /Renamed/);
    expect((await mm.waitForBotUser(second, 30_000)).id).toBe(bot.id);
    expect(
      await reaches(second, "new-b"),
      `@${second} did not reach the renamed agent`,
    ).toBe(true);
    log(`renamed ${first} to ${second} from the chat`);

    // ── !delete-agent, then confirmed ───────────────────────────────────────
    sinceMs = Date.now();
    await mm.post({ channelId, message: `!delete-agent @${second}` });
    await switchReply(mm, channelId, admin.id, sinceMs, /To go ahead/);
    expect(
      (await switchClient.listAgents()).some((a) => a.id === agent.id),
    ).toBe(true);

    sinceMs = Date.now();
    await mm.post({ channelId, message: `!delete-agent ${second} confirm` });
    await switchReply(mm, channelId, admin.id, sinceMs, /Deleted/);
    // The delete reaches the agent list once it has committed.
    for (let attempt = 0; attempt < 10; attempt++) {
      if (!(await switchClient.listAgents()).some((a) => a.id === agent.id))
        break;
      await sleep(1_000);
    }
    expect(
      (await switchClient.listAgents()).some((a) => a.id === agent.id),
    ).toBe(false);
    fixtures.removed(agent);
  },
};

async function switchReply(
  mm: MattermostClient,
  channelId: string,
  adminBotId: string,
  sinceMs: number,
  pattern: RegExp,
): Promise<MattermostPost> {
  const found = await mm.waitForPost({
    channelId,
    fromUserId: adminBotId,
    predicate: (post) => pattern.test(post.message),
    sinceMs,
    deadlineMs: 60_000,
  });
  if (!found.match) {
    throw new Error(
      `Switch never replied with ${pattern}. Transcript: ` +
        found.transcript.map((p) => `${p.user_id}: ${p.message}`).join(" | "),
    );
  }
  return found.match;
}

async function reachesAgent(
  switchClient: SwitchClient,
  mm: MattermostClient,
  marker: string,
  agent: RegisteredAgent,
  channelId: string,
  name: string,
): Promise<boolean> {
  await mm.post({ channelId, message: `@${name} ping ${marker}` });
  const seen = await switchClient.waitForNotification(
    agent,
    (event) => eventText(event).includes(marker),
    20_000,
  );
  return seen.match !== null;
}
