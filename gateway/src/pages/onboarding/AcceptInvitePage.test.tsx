import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "../../data/AuthContext";
import AcceptInvitePage, { joinSentence } from "./AcceptInvitePage";

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));

type Answer = [number, unknown];

function answer(routes: Record<string, Answer>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^\/gateway/, "");
    const [status, body] = routes[`${init?.method ?? "GET"} ${path}`] ?? [
      404,
      { detail: `unmocked ${path}` },
    ];
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const MEMBERSHIP = {
  id: "w1",
  slug: "acme",
  name: "Acme",
  role: "admin",
  organization_role: "member",
  organization_id: "o1",
  archived_at: null,
};

beforeEach(() => {
  vi.mocked(useAuth).mockReturnValue({ refresh: vi.fn() } as unknown as ReturnType<
    typeof useAuth
  >);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe("joinSentence", () => {
  it("names the workspace, its organization and the role", () => {
    expect(
      joinSentence({ workspace_name: "Acme", organization_name: "Acme Inc", role: "member" }),
    ).toBe("Join Acme in Acme Inc as Member");
    expect(joinSentence({ workspace_name: "Old", organization_name: null, role: "admin" })).toBe(
      "Join Old as Workspace admin",
    );
  });
});

describe("AcceptInvitePage", () => {
  it("says what the invitation is to before accepting", async () => {
    answer({
      "POST /invitations/preview": [
        200,
        { workspace_name: "Acme", organization_name: "Acme Inc", role: "admin" },
      ],
    });
    render(<AcceptInvitePage token="tok" />);

    expect(await screen.findByText("Join Acme in Acme Inc as Workspace admin?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Accept invitation" })).toBeTruthy();
  });

  it("shows why an invitation won't work, and offers no accept", async () => {
    answer({
      "POST /invitations/preview": [
        403,
        { detail: "This invitation no longer works: whoever made it no longer administers this workspace. Ask a workspace admin for a new one." },
      ],
    });
    render(<AcceptInvitePage token="tok" />);

    expect(await screen.findByText(/whoever made it no longer administers/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept invitation" })).toBeNull();
  });

  it("says so when you're already in the workspace at that role", async () => {
    answer({
      "POST /invitations/preview": [
        200,
        { workspace_name: "Acme", organization_name: "Acme Inc", role: "member" },
      ],
      "POST /invitations/accept": [200, { ...MEMBERSHIP, already_member: true }],
    });
    render(<AcceptInvitePage token="tok" />);

    fireEvent.click(await screen.findByRole("button", { name: "Accept invitation" }));

    expect(
      await screen.findByText("You're already in Acme as Workspace admin, so nothing changed."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open the workspace" })).toBeTruthy();
  });
});
