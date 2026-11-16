import { expect } from "vitest";
import { SwitchHttpError, errorDetail } from "../clients/switch-client.ts";
import type { FastScenario } from "./scenario.ts";

async function status(call: () => Promise<unknown>): Promise<[number, string]> {
  try {
    await call();
  } catch (error) {
    if (error instanceof SwitchHttpError) return [error.status, errorDetail(error.body)];
    throw error;
  }
  return [200, ""];
}

/**
 * A workspace admin finds a Public room on a private Mattermost channel in
 * the review of such rooms, and makes it Private; a room it cannot find is
 * skipped and said so. A plain member may not see the review.
 *
 * The room is made for the run and deleted afterwards. Only it is changed:
 * other rooms the review lists are left alone.
 */
export const privateChannelRooms: FastScenario = {
  header: {
    id: "private-channel-rooms",
    covers: [
      "GET /gateway/tenants/{tenant_id}/private-channel-rooms",
      "GET /gateway/tenants/{tenant_id}/private-channel-rooms/count",
      "POST /gateway/tenants/{tenant_id}/private-channel-rooms/ask-platform",
      "POST /gateway/tenants/{tenant_id}/private-channel-rooms/make-private",
    ],
    lane: "fast",
    environments: ["ephemeral"],
    owner: "platform",
    requires: ["mattermost"],
  },
  async run({ names, switchClient, fixtures }) {
    const workspace = await switchClient.tenantId();
    const bridgeId = await switchClient.defaultBridgeId("mattermost");
    const room = await switchClient.createRoom({
      name: names.name("hidden"),
      description: `Switch end-to-end harness (run ${names.runId}). Safe to delete.`,
      bridgeId,
      agentNames: [],
      userNames: [],
      channelType: "channel_private",
      readVisibility: "public",
    });
    fixtures.defer(`the room ${room.id}`, async () => {
      const [code, detail] = await status(() => switchClient.deleteRoom(room.id));
      if (code !== 200 && code !== 404) throw new Error(`${code}: ${detail}`);
    });

    expect(
      await switchClient.countPrivateChannelRooms(workspace),
      "the count, with the run's room in it",
    ).toBeGreaterThanOrEqual(1);
    const listed = (await switchClient.previewPrivateChannelRooms(workspace)).find(
      (r) => r.room_id === room.id,
    );
    expect(listed, "the run's room in the review").toMatchObject({
      channel_type: "channel_private",
      members_listed: true,
      cautions: [],
      recommended: true,
    });

    // Its type is recorded, so there is nothing to ask the app about it.
    const asked = await switchClient.askPlatformAboutRooms(workspace, [room.id]);
    expect(asked, "asking about a room of recorded type").toMatchObject({
      answered: [],
      unanswered: [],
      stopped: null,
    });

    const password = `e2e-${names.runId}-${crypto.randomUUID()}`;
    const memberName = names.name("onlooker");
    const email = `${memberName}@e2e.invalid`;
    const { id } = await switchClient.createUser({
      name: memberName,
      email,
      password,
      role: "user",
    });
    fixtures.defer(`the account ${email}`, async () => {
      const [code, detail] = await status(() => switchClient.deleteUser(id));
      if (code !== 200 && code !== 404) throw new Error(`${code}: ${detail}`);
    });
    const member = switchClient.as(email, password);
    await member.tenantId();
    const [memberLooks] = await status(() => member.previewPrivateChannelRooms(workspace));
    expect(memberLooks, "a plain member opening the review").toBe(403);

    const result = await switchClient.makeRoomsPrivate(workspace, [room.id, "no-such-room"]);
    expect(result, "making the run's room Private").toEqual({
      changed: [room.id],
      skipped: [{ room_id: "no-such-room", reason: "not_found" }],
    });
    const after = await switchClient.previewPrivateChannelRooms(workspace);
    expect(
      after.some((r) => r.room_id === room.id),
      "the run's room in the review afterwards",
    ).toBe(false);
  },
};
