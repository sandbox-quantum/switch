import { describe, expect, it } from "vitest";
import type { TenantMembership } from "./api";
import {
  type OrganizationName,
  countsLabel,
  organizationName,
  switcherSections,
  switcherWorkspaces,
} from "./workspaceSwitcher";

function workspace(id: string, name: string, organizationId: string | null): TenantMembership {
  return {
    id,
    slug: id,
    name,
    role: "member",
    organization_role: organizationId === null ? null : "member",
    organization_id: organizationId,
    archived_at: null,
  };
}

function organization(id: string, name: string): OrganizationName {
  return { id, name };
}

const names = (workspaces: TenantMembership[]) => workspaces.map((w) => w.name);

describe("switcherWorkspaces", () => {
  it("lists the session's workspaces", () => {
    const a = workspace("a", "A", "o1");
    const b = workspace("b", "B", "o1");
    expect(switcherWorkspaces(a, [a, b])).toEqual([a, b]);
  });

  it("adds the current workspace where it is none of them, as the operator's entered one", () => {
    const a = workspace("a", "A", "o1");
    const entered = workspace("x", "Elsewhere", "o9");
    expect(switcherWorkspaces(entered, [a])).toEqual([entered, a]);
  });
});

describe("switcherSections", () => {
  it("heads each organization with its name, in name order", () => {
    const { sections, headed } = switcherSections(
      [
        workspace("1", "Zeta", "o2"),
        workspace("2", "Beta", "o1"),
        workspace("3", "Alpha", "o2"),
      ],
      [organization("o1", "Umbrella"), organization("o2", "Acme")],
    );
    expect(headed).toBe(true);
    expect(sections.map((s) => s.name)).toEqual(["Acme", "Umbrella"]);
    expect(names(sections[0].workspaces)).toEqual(["Alpha", "Zeta"]);
  });

  it("puts the workspaces of no organization last", () => {
    const { sections, headed } = switcherSections(
      [workspace("1", "Loose", null), workspace("2", "Kept", "o1")],
      [organization("o1", "Acme")],
    );
    expect(headed).toBe(true);
    expect(sections.map((s) => s.organizationId)).toEqual(["o1", null]);
  });

  it("leaves one organization unheaded", () => {
    const { sections, headed } = switcherSections(
      [workspace("1", "B", "o1"), workspace("2", "A", "o1")],
      [organization("o1", "Acme")],
    );
    expect(headed).toBe(false);
    expect(names(sections[0].workspaces)).toEqual(["A", "B"]);
  });

  it("lists everything in one unheaded section when an organization has no name to show", () => {
    const { sections, headed } = switcherSections(
      [workspace("1", "B", "o1"), workspace("2", "A", "o2")],
      [organization("o1", "Acme")],
    );
    expect(headed).toBe(false);
    expect(sections).toHaveLength(1);
    expect(names(sections[0].workspaces)).toEqual(["A", "B"]);
  });
});

describe("organizationName", () => {
  it("names a known organization, and nothing else", () => {
    const organizations = [organization("o1", "Acme")];
    expect(organizationName("o1", organizations)).toBe("Acme");
    expect(organizationName("o2", organizations)).toBeNull();
    expect(organizationName(null, organizations)).toBeNull();
  });
});

describe("countsLabel", () => {
  it("matches each noun to its number", () => {
    expect(countsLabel({ id: "a", users: 1, agents: 3 })).toBe("1 user · 3 agents");
    expect(countsLabel({ id: "a", users: 2, agents: 0 })).toBe("2 users · 0 agents");
  });
});
