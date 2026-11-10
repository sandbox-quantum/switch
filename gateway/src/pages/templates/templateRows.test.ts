import { describe, expect, it } from "vitest";
import type { TemplateSummary } from "../../data/api";
import {
  OFFICIAL_EDIT_REASON,
  TEMPLATE_NAME_MAX,
  consoleRunLink,
  copyName,
  kindLabel,
  newestFirst,
  ownerLabel,
  templateMenu,
} from "./templateRows";

const template = (over: Partial<TemplateSummary> = {}): TemplateSummary => ({
  id: "t-1",
  owner_id: "u-2",
  owner_name: "Bob",
  official: false,
  name: "Standup",
  description: "A daily standup room",
  kind: "room",
  read_visibility: "public",
  write_visibility: "private",
  can_edit: false,
  can_manage: false,
  run_blocked_reason: null,
  run_count: 0,
  version: 1,
  size_bytes: 10,
  created_at: "2026-11-01 09:00:00+00:00",
  updated_at: "2026-11-01 09:00:00+00:00",
  ...over,
});

const reasons = (t: TemplateSummary) =>
  Object.fromEntries(templateMenu(t).map((item) => [item.action, item.disabledReason]));

describe("templateMenu", () => {
  it("offers its owner or an admin everything", () => {
    expect(reasons(template({ can_edit: true, can_manage: true }))).toEqual({
      run: null,
      edit: null,
      duplicate: null,
      delete: null,
    });
  });

  it("greys Edit and Delete on someone else's template, naming them", () => {
    expect(reasons(template())).toEqual({
      run: null,
      edit: "“Standup” belongs to Bob. Only they or a workspace admin can change it.",
      duplicate: null,
      delete: "“Standup” belongs to Bob. Only they or a workspace admin can delete it.",
    });
  });

  it("leaves Edit open on a template anyone may edit, while Delete stays its owner's", () => {
    const menu = reasons(template({ write_visibility: "public", can_edit: true }));
    expect(menu.edit).toBeNull();
    expect(menu.delete).toBe(
      "“Standup” belongs to Bob. Only they or a workspace admin can delete it.",
    );
  });

  it("says a template whose owner has left is an admin's to change", () => {
    expect(reasons(template({ owner_name: null })).edit).toBe(
      "“Standup” belongs to a former member. Only a workspace admin can change it.",
    );
  });

  it("offers Run and Duplicate on an official template, greys Edit, and has no Delete", () => {
    const menu = templateMenu(template({ official: true, owner_id: null, owner_name: "Switch" }));
    expect(menu).toEqual([
      { action: "run", disabledReason: null },
      { action: "edit", disabledReason: OFFICIAL_EDIT_REASON },
      { action: "duplicate", disabledReason: null },
    ]);
  });

  it("greys Run with the server's reason", () => {
    const reason = "Switch Console sets up your switch-buddy for you.";
    expect(reasons(template({ official: true, run_blocked_reason: reason })).run).toBe(reason);
  });
});

describe("copyName", () => {
  it("picks the first copy name the viewer does not use", () => {
    expect(copyName("Standup", new Set())).toBe("Standup (copy)");
    expect(copyName("Standup", new Set(["Standup (copy)", "Standup (copy 2)"]))).toBe(
      "Standup (copy 3)",
    );
  });

  it("cuts a long name so the copy still fits", () => {
    const long = "x".repeat(TEMPLATE_NAME_MAX);
    const copy = copyName(long, new Set());
    expect(copy).toHaveLength(TEMPLATE_NAME_MAX);
    expect(copy.endsWith(" (copy)")).toBe(true);
  });
});

describe("the rest of a row", () => {
  it("names the kinds the product uses, and shows any other as written", () => {
    expect(["agent", "room", "group", "pipeline"].map(kindLabel)).toEqual([
      "Agent",
      "Room",
      "Group",
      "pipeline",
    ]);
  });

  it("calls an owner who has left a former member", () => {
    expect(ownerLabel(template({ owner_name: null }))).toBe("Former member");
  });

  it("lists the newest first", () => {
    const older = template({ id: "a", updated_at: "2026-10-01 09:00:00+00:00" });
    const newer = template({ id: "b", updated_at: "2026-11-02 09:00:00+00:00" });
    expect(newestFirst([older, newer]).map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("links to the template's Use form in this workspace, on this Switch", () => {
    expect(consoleRunLink("official:switch-expert", "ten-1", "https://switch.example.com")).toBe(
      "switchdash://open/template/official%3Aswitch-expert" +
        "?server=https%3A%2F%2Fswitch.example.com&workspace=ten-1&use=1",
    );
  });
});
