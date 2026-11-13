import { describe, expect, it } from "vitest";
import { roomStanding, roomStandingText } from "./roomStanding";

// A Slack channel room owned by someone else, seen by a workspace member who
// takes no part in it: what the server reports for a bystander.
const room = {
  owner_id: "owner",
  channel_type: "channel_public",
  bridge_id: "b1",
  bridge_type: "slack",
  viewer_is_member: false,
  viewer_is_room_admin: false,
  can_manage: false,
  can_attach: false,
  can_invite_agents: false,
  can_add_people: false,
};

const me = { id: "u-me", administersOrganization: false, isOperator: false, adminMember: false };

const inRoom = {
  ...room,
  viewer_is_member: true,
  can_attach: true,
  can_invite_agents: true,
  can_add_people: true,
};

describe("roomStanding", () => {
  it("knows the owner by their id", () => {
    expect(roomStanding({ ...room, owner_id: "u-me", can_manage: true }, me)).toBe("owner");
  });

  it("takes anyone else the server lets delete the room for an admin, and says of what", () => {
    const manages = { ...room, can_manage: true };
    expect(roomStanding(manages, { ...me, adminMember: true })).toBe("workspace_admin");
    expect(roomStanding(manages, { ...me, administersOrganization: true })).toBe("org_admin");
    // The operator bit alone makes an admin of a workspace they aren't in.
    expect(roomStanding(manages, { ...me, isOperator: true })).toBe("operator");
    expect(roomStanding(manages, { ...me, isOperator: true, adminMember: true })).toBe(
      "workspace_admin",
    );
  });

  it("puts a room admin above taking part", () => {
    expect(roomStanding({ ...inRoom, viewer_is_room_admin: true }, me)).toBe("room_admin");
  });

  it("tells taking part from only seeing the room", () => {
    expect(roomStanding(inRoom, me)).toBe("in_room");
    expect(roomStanding(room, me)).toBe("view_only");
  });

  it("owns nothing for a viewer it doesn't know, in a room with no owner", () => {
    expect(roomStanding({ ...room, owner_id: null }, { ...me, id: null })).toBe("view_only");
  });
});

describe("roomStandingText", () => {
  it("tells someone in the room what they may add, as the server allows it", () => {
    expect(roomStandingText(inRoom, "in_room")).toBe(
      "You can add agents, people and resources. Changing the room is for its owner, its room admins and workspace admins.",
    );
    // A group chat's members are its platform's to change.
    expect(
      roomStandingText(
        { ...inRoom, channel_type: "group", can_invite_agents: false, can_add_people: false },
        "in_room",
      ),
    ).toBe(
      "You can add resources. Changing the room is for its owner, its room admins and workspace admins.",
    );
  });

  it("tells a bystander how to take part in a channel's room", () => {
    expect(roomStandingText(room, "view_only")).toBe(
      "You can see this room but not change it or add to it. To take part, join its Slack channel from a chat account you have linked to Switch, or ask someone in the room to add you.",
    );
    expect(roomStandingText({ ...room, bridge_type: "teams" }, "view_only")).toContain(
      "join its Microsoft Teams channel",
    );
  });

  it("offers no way in where the viewer can't take one", () => {
    const seeOnly = "You can see this room but not change it or add to it.";
    expect(roomStandingText({ ...room, bridge_id: null, bridge_type: null }, "view_only")).toBe(
      seeOnly,
    );
    expect(roomStandingText({ ...room, channel_type: "direct" }, "view_only")).toBe(seeOnly);
  });

  it("says what stays with the owner for a room admin", () => {
    expect(roomStandingText(inRoom, "room_admin")).toContain(
      "Deleting it, changing who can see it and choosing room admins stay with its owner and workspace admins.",
    );
  });
});
