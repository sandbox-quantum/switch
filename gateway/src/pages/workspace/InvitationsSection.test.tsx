import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import InvitationsSection from "./InvitationsSection";

vi.mock("../../components/DataTable", () => import("../../test/FakeDataTable"));

/** Answers each `GET /path` from `routes`, and counts what was asked. */
function answer(routes: Record<string, unknown>) {
  const asked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).replace(/^\/gateway/, "").split("?")[0];
      asked.push(path);
      if (!(path in routes)) {
        return new Response(JSON.stringify({ detail: `unmocked ${path}` }), { status: 404 });
      }
      const [status, body] = routes[path] as [number, unknown];
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return asked;
}

const organization = (fromDirectory: boolean) => ({
  id: "o1",
  slug: "acme",
  name: "Acme Inc",
  role: "member",
  members_from_directory: fromDirectory,
});

describe("InvitationsSection", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("says only people already in the organization can accept, where it is kept elsewhere", async () => {
    answer({
      "/tenants/t1/invitations": [200, []],
      "/organizations/current": [200, organization(true)],
    });

    render(<InvitationsSection tenantId="t1" inOrganization emailEnabled={false} />);

    expect(await screen.findByText(/only people already in the organization can accept/)).toBeTruthy();
  });

  it("says nothing of it for an organization kept here", async () => {
    answer({
      "/tenants/t1/invitations": [200, []],
      "/organizations/current": [200, organization(false)],
    });

    render(<InvitationsSection tenantId="t1" inOrganization emailEnabled={false} />);

    expect(await screen.findByRole("button", { name: "Invite" })).toBeTruthy();
    expect(screen.queryByText(/already in the organization/)).toBeNull();
  });

  it("asks nothing about an organization for a workspace in none", async () => {
    const asked = answer({ "/tenants/t1/invitations": [200, []] });

    render(<InvitationsSection tenantId="t1" inOrganization={false} emailEnabled={false} />);

    expect(await screen.findByRole("button", { name: "Invite" })).toBeTruthy();
    expect(asked).not.toContain("/organizations/current");
    expect(screen.queryByText(/Could not check/)).toBeNull();
  });

  it("shows a failure to check as a warning", async () => {
    answer({
      "/tenants/t1/invitations": [200, []],
      "/organizations/current": [500, { detail: "The database is unavailable" }],
    });

    render(<InvitationsSection tenantId="t1" inOrganization emailEnabled={false} />);

    expect(await screen.findByText(/Could not check who can accept an invitation here/)).toBeTruthy();
  });
});
