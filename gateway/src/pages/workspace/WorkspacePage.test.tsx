import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import WorkspacePage from "./WorkspacePage";

let role = "owner";
let hostedV2: boolean | null = false;
vi.mock("../../data/hooks", () => ({ useHostedV2: () => hostedV2 }));
vi.mock("../../data/AuthContext", () => ({
  useAuth: () => ({
    session: {
      user: { id: "u1" },
      tenant: { id: "t1", name: "Example Co", role },
      invite_email_enabled: false,
    },
    canAdminTenant: false,
  }),
}));
vi.mock("../../data/sessionState", () => ({ ownsTenant: () => role === "owner" }));
vi.mock("./MembersSection", () => ({ default: () => null }));
vi.mock("./InvitationsSection", () => ({ default: () => null }));

describe("WorkspacePage", () => {
  afterEach(() => cleanup());

  it.each([
    ["owner", "You are an owner of this workspace."],
    ["admin", "You are an admin of this workspace."],
    ["member", "You are a member of this workspace."],
  ])("with hosted agents v2 on, says the right article for a %s (designer's fix list, item 11)", (r, line) => {
    role = r;
    hostedV2 = true;
    render(<WorkspacePage />);
    expect(screen.getByText(line)).toBeTruthy();
  });

  it.each([
    ["owner", "You are a owner of this workspace."],
    ["admin", "You are an admin of this workspace."],
    ["member", "You are a member of this workspace."],
  ])("with v2 off, reads exactly as on main for a %s", (r, line) => {
    role = r;
    hostedV2 = false;
    render(<WorkspacePage />);
    expect(screen.getByText(line)).toBeTruthy();
  });
});
