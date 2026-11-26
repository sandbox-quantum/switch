import { afterEach, describe, expect, it, vi } from "vitest";
import type { TemplateSummary } from "../../data/api";
import {
  OFFICIAL_EDIT_REASON,
  TEMPLATE_NAME_MAX,
  consoleBuddyLink,
  consoleRunLink,
  consoleTemplatesLink,
  copyName,
  createsLine,
  ownerLabel,
  templateMenu,
  useCaseLabel,
} from "./templateRows";

const template = (over: Partial<TemplateSummary> = {}): TemplateSummary => ({
  id: "t-1",
  owner_id: "u-2",
  owner_name: "Bob",
  official: false,
  name: "Standup",
  description: "A daily standup room",
  kind: "room",
  use_case: null,
  agent_count: 0,
  room_count: 1,
  read_visibility: "public",
  write_visibility: "private",
  can_edit: false,
  can_manage: false,
  run_blocked_reason: null,
  run_count: 0,
  last_run_at: null,
  version: 1,
  size_bytes: 10,
  created_at: "2026-11-01 09:00:00+00:00",
  updated_at: "2026-11-01 09:00:00+00:00",
  ...over,
});

const reasons = (t: TemplateSummary) =>
  Object.fromEntries(templateMenu(t).map((item) => [item.action, item.disabledReason]));

afterEach(() => {
  vi.useRealTimers();
});

describe("templateMenu", () => {
  it("offers its owner or an admin everything", () => {
    expect(reasons(template({ can_edit: true, can_manage: true }))).toEqual({
      edit: null,
      duplicate: null,
      delete: null,
    });
  });

  it("greys Edit and Delete on someone else's template, naming them", () => {
    expect(reasons(template())).toEqual({
      edit: "“Standup” belongs to Bob. Only they or a workspace admin can change it.",
      duplicate: null,
      delete: "“Standup” belongs to Bob. Only they or a workspace admin can delete it.",
    });
  });

  it("leaves Edit open on a template anyone may edit, while Delete stays its owner's", () => {
    const menu = reasons(template({ write_visibility: "public", can_edit: true }));
    expect(menu.edit).toBeNull();
    expect(menu.delete).toBe("“Standup” belongs to Bob. Only they or a workspace admin can delete it.");
  });

  it("says a template whose owner has left is an admin's to change", () => {
    expect(reasons(template({ owner_name: null })).edit).toBe(
      "“Standup” belongs to a former member. Only a workspace admin can change it.",
    );
  });

  it("offers Duplicate on an official template, greys Edit, and has no Delete", () => {
    const menu = templateMenu(template({ official: true, owner_id: null, owner_name: "Switch" }));
    expect(menu).toEqual([
      { action: "edit", disabledReason: OFFICIAL_EDIT_REASON },
      { action: "duplicate", disabledReason: null },
    ]);
  });
});

describe("copyName", () => {
  it("picks the first copy name the viewer does not use", () => {
    expect(copyName("Standup", new Set())).toBe("Standup (copy)");
    expect(copyName("Standup", new Set(["Standup (copy)", "Standup (copy 2)"]))).toBe("Standup (copy 3)");
  });

  it("cuts a long name so the copy still fits", () => {
    const long = "x".repeat(TEMPLATE_NAME_MAX);
    const copy = copyName(long, new Set());
    expect(copy).toHaveLength(TEMPLATE_NAME_MAX);
    expect(copy.endsWith(" (copy)")).toBe(true);
  });
});

describe("what a card says", () => {
  it("labels each use case", () => {
    expect(useCaseLabel("ops")).toBe("Operations");
    expect(useCaseLabel("engineering")).toBe("Engineering");
  });

  it("says what a template creates, leaving out a part that is zero", () => {
    expect(createsLine(template({ agent_count: 3, room_count: 1 }))).toBe("3 agents · 1 room");
    expect(createsLine(template({ agent_count: 1, room_count: 2 }))).toBe("1 agent · 2 rooms");
    expect(createsLine(template({ agent_count: 2, room_count: 0 }))).toBe("2 agents");
    expect(createsLine(template({ agent_count: 0, room_count: 1 }))).toBe("1 room");
    expect(createsLine(template({ agent_count: 0, room_count: 0 }))).toBeNull();
  });

  it("says nothing of what it creates when the server could not read the document", () => {
    expect(createsLine(template({ agent_count: null, room_count: null }))).toBeNull();
  });

  it("calls an owner who has left a former member", () => {
    expect(ownerLabel(template({ owner_name: null }))).toBe("Former member");
  });
});

describe("Switch Console links", () => {
  it("opens the template's Use form in this workspace, on this Switch", () => {
    expect(consoleRunLink("official:switch-expert", "ten-1", "https://switch.example.com")).toBe(
      "switchdash://open/template/official%3Aswitch-expert" +
        "?server=https%3A%2F%2Fswitch.example.com&workspace=ten-1&use=1",
    );
  });

  it("opens a chat with the person's own agent, or the Templates page", () => {
    expect(consoleBuddyLink("ten-1", "https://switch.example.com")).toBe(
      "switchdash://open/buddy?server=https%3A%2F%2Fswitch.example.com&workspace=ten-1",
    );
    expect(consoleTemplatesLink("ten-1", "https://switch.example.com")).toBe(
      "switchdash://open/templates?server=https%3A%2F%2Fswitch.example.com&workspace=ten-1",
    );
  });
});
