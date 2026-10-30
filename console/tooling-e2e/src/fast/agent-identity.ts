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
 * 0. the human links their chat account: the link waits, listed as pending,
 *    until the account posts a code from the gateway, which is what makes
 *    the chat commands recognise them. A link already in place (the stack's
 *    setup makes one, and one from before links needed confirming reads as
 *    unconfirmed) is undone first, so the confirmation always runs, and the
 *    account ends up linked and confirmed either way;
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
      "DELETE /gateway/collaborations/{bridge_id}/identities/{external_user_row_id}",
      "DELETE /gateway/collaborations/{bridge_id}/identities/{external_user_row_id}/request",
      "GET /gateway/auth/me/identities/pending",
      "GET /gateway/collaborations/{bridge_id}/identities/unconfirmed",
      "POST /gateway/collaborations/{bridge_id}/identities/{external_user_row_id}/code",
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
    // their chat account; the gateway admin the harness signs in as links it,
    // and the account confirms by posting the code.
    const claim = (): ReturnType<SwitchClient["claimIdentity"]> =>
      switchClient.claimIdentity(
        "mattermost",
        bridged.human.id,
        bridged.human.username,
      );
    let link = await claim();
    // Already linked, confirmed (no code) or not (not listed as waiting).
    if (
      link.code === null ||
      !(await switchClient.pendingIdentityIds()).includes(link.identityId)
    ) {
      await switchClient.releaseIdentity(link.bridgeId, link.identityId);
      link = await claim();
    }
    expect(link.code).not.toBeNull();
    expect(await switchClient.pendingIdentityIds()).toContain(link.identityId);
    // Cancelling stops the wait; linking again starts a new one.
    await switchClient.cancelLinkRequest(link.bridgeId, link.identityId);
    expect(await switchClient.pendingIdentityIds()).not.toContain(
      link.identityId,
    );
    link = await claim();
    expect(link.code).not.toBeNull();
    const admin = await mm.waitForBotUser("switch-admin", 30_000);
    // A fresh code replaces the first, which then confirms nothing.
    const code = await switchClient.issueLinkCode(
      link.bridgeId,
      link.identityId,
    );
    let sinceLink = Date.now();
    await mm.post({ channelId, message: `!link-account ${link.code}` });
    await switchReply(mm, channelId, admin.id, sinceLink, /doesn't match/);
    sinceLink = Date.now();
    await mm.post({ channelId, message: `!link-account ${code}` });
    await switchReply(mm, channelId, admin.id, sinceLink, /Linked this/);
    expect(await switchClient.pendingIdentityIds()).not.toContain(
      link.identityId,
    );
    // Confirmed, so not among the older links an admin could demote.
    expect(await switchClient.unconfirmedLinkIds(link.bridgeId)).not.toContain(
      link.identityId,
    );
    log("linked the chat account by posting its code");
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
