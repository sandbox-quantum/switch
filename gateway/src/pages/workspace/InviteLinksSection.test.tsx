import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Invitation, Member } from "../../data/api";
import InviteLinksSection from "./InviteLinksSection";
import { announceInvitationCreated } from "./invitationEvents";

vi.mock("../../components/DataTable", () => import("../../test/FakeDataTable"));

const FUTURE = "2999-01-01T00:00:00Z";
const PAST = "2000-01-01T00:00:00Z";

function invitation(overrides: Partial<Invitation> & { id: string }): Invitation {
  return {
    role: "member",
    email: null,
    expires_at: FUTURE,
    uses_remaining: 1,
    revoked_at: null,
    created_by: "ann",
    created_at: "2026-11-01T00:00:00Z",
    ...overrides,
  };
}

const MEMBERS = [{ user_id: "ann", name: "Ann" }] as Member[];

const LINKS = [
  invitation({ id: "old", email: "old@example.com", created_at: "2026-11-01T00:00:00Z" }),
  invitation({ id: "new", role: "admin", created_at: "2026-11-05T00:00:00Z", created_by: "gone" }),
  invitation({ id: "expired", email: "late@example.com", expires_at: PAST }),
  invitation({ id: "used", email: "used@example.com", uses_remaining: 0 }),
  invitation({ id: "revoked", email: "rev@example.com", revoked_at: "2026-11-02T00:00:00Z" }),
];

function stubFetch(links: Invitation[]) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === "DELETE" ? new Response("{}") : new Response(JSON.stringify(links)),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function shownIds() {
  return screen.queryAllByTestId(/^row-/).map((row) => row.dataset.testid?.slice(4));
}

describe("InviteLinksSection", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists the active links, newest first, with who made each", async () => {
    stubFetch(LINKS);
    render(<InviteLinksSection tenantId="t1" inOrganization={false} members={MEMBERS} />);

    await waitFor(() => expect(shownIds()).toEqual(["new", "old"]));
    const newest = screen.getByTestId("row-new");
    expect(within(newest).getByText("Anyone with the link")).toBeTruthy();
    expect(within(newest).getByText("Workspace admin")).toBeTruthy();
    expect(within(newest).getByText("Someone no longer here")).toBeTruthy();
    expect(within(screen.getByTestId("row-old")).getByText("Ann")).toBeTruthy();
    expect(screen.queryByText("Status")).toBeNull();
  });

  it("doesn't guess who made a link before the roster has loaded", async () => {
    stubFetch(LINKS);
    render(<InviteLinksSection tenantId="t1" inOrganization={false} members={null} />);

    await waitFor(() => expect(shownIds()).toEqual(["new", "old"]));
    expect(screen.queryByText("Someone no longer here")).toBeNull();
    expect(screen.queryByText("Ann")).toBeNull();
    expect(within(screen.getByTestId("row-old")).getByText("—")).toBeTruthy();
  });

  it("shows the ended links on request, and offers to revoke only active ones", async () => {
    stubFetch(LINKS);
    render(<InviteLinksSection tenantId="t1" inOrganization={false} members={MEMBERS} />);
    await waitFor(() => expect(shownIds()).toHaveLength(2));

    fireEvent.click(screen.getByLabelText("Show ended links"));

    expect(shownIds()).toHaveLength(5);
    expect(within(screen.getByTestId("row-expired")).getByText("Expired")).toBeTruthy();
    expect(within(screen.getByTestId("row-used")).getByText("Used")).toBeTruthy();
    expect(within(screen.getByTestId("row-revoked")).getByText("Revoked")).toBeTruthy();
    for (const ended of ["expired", "used", "revoked"]) {
      expect(within(screen.getByTestId(`row-${ended}`)).queryByRole("button")).toBeNull();
    }
    expect(within(screen.getByTestId("row-old")).getByRole("button", { name: /Actions for/ })).toBeTruthy();
  });

  it("revokes a link after a confirm, then reads the list again", async () => {
    const fetchMock = stubFetch(LINKS);
    render(<InviteLinksSection tenantId="t1" inOrganization={false} members={MEMBERS} />);
    await waitFor(() => expect(shownIds()).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "Actions for the link for old@example.com" }));
    fireEvent.click(screen.getByText("Revoke link"));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Revoke" }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true),
    );
    const [url] = fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE")!;
    expect(url).toContain("/tenants/t1/invitations/old");
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, i]) => !i?.method || i.method === "GET")).toHaveLength(2));
  });

  it("reads the list again when a link is made elsewhere on the page", async () => {
    const fetchMock = stubFetch([]);
    render(<InviteLinksSection tenantId="t1" inOrganization={false} members={MEMBERS} />);
    expect(await screen.findByText("No active invite links")).toBeTruthy();

    act(() => announceInvitationCreated());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
