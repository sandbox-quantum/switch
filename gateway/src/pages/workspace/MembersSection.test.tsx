import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MembersSection from "./MembersSection";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("../../data/AuthContext", () => ({ useAuth: () => ({ refresh }) }));

vi.mock("../../components/DataTable", () => import("../../test/FakeDataTable"));

const member = (overrides: Record<string, unknown>) => ({
  name: "x",
  email: "x@example.com",
  role: "member",
  created_at: "2026-01-01",
  organization_role: "member",
  via_organization: false,
  can_change_role: false,
  can_remove: false,
  can_receive_transfer: true,
  ...overrides,
});

describe("MembersSection", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("offers each row only what the server says the caller may do", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              member({ user_id: "u1", name: "Me", email: "me@example.com", role: "admin" }),
              member({
                user_id: "u2",
                name: "Bob",
                email: "bob@example.com",
                can_change_role: true,
                can_remove: true,
              }),
            ]),
          ),
      ),
    );

    render(<MembersSection tenantId="t1" selfId="u1" />);

    expect(await screen.findByLabelText("Role for bob@example.com")).toBeTruthy();
    expect(screen.getByLabelText("Remove bob@example.com")).toBeTruthy();
    // Your own row, where the server says no: as the last admin, say.
    expect(screen.queryByLabelText("Role for me@example.com")).toBeNull();
    expect(screen.queryByLabelText("Leave this workspace")).toBeNull();
  });

  it("lets an admin leave from their own row, saying who takes over, then follows the session", async () => {
    refresh.mockReset();
    const ann = { user_id: "u0", name: "Ann", email: "ann@example.com" };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return new Response(
          JSON.stringify({ ok: true, warning: null, handed_over_to: ann, handed_over: { room: 1 } }),
        );
      }
      if (url.endsWith("/members/u1/removal")) {
        return new Response(JSON.stringify({ handed_over_to: ann }));
      }
      return new Response(
        JSON.stringify([
          member({
            user_id: "u1",
            name: "Me",
            email: "me@example.com",
            role: "admin",
            can_change_role: true,
            can_remove: true,
          }),
        ]),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MembersSection tenantId="t1" selfId="u1" />);
    expect(await screen.findByLabelText("Role for me@example.com")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Leave this workspace"));

    const dialog = await screen.findByRole("dialog", { name: "Leave this workspace?" });
    expect(dialog.textContent).toContain("passes to Ann (ann@example.com)");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    const reads = fetchMock.mock.calls.filter(
      ([url, init]) => init?.method !== "DELETE" && !String(url).endsWith("/removal"),
    );
    // Read once, and not again for a workspace the session has moved off.
    expect(reads).toHaveLength(1);
  });

  it("names who receives what a member owns before removing them, and what passed after", async () => {
    const bob = member({
      user_id: "u2",
      name: "Bob",
      email: "bob@example.com",
      can_change_role: true,
      can_remove: true,
    });
    const me = { user_id: "u1", name: "Me", email: "me@example.com" };
    let removed = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        removed = true;
        return new Response(
          JSON.stringify({
            ok: true,
            warning: "Could not revoke a GitHub sign-in.",
            handed_over_to: me,
            handed_over: { room: 2, template: 1 },
          }),
        );
      }
      if (url.endsWith("/members/u2/removal")) {
        return new Response(JSON.stringify({ handed_over_to: me }));
      }
      return new Response(JSON.stringify(removed ? [] : [bob]));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MembersSection tenantId="t1" selfId="u1" />);
    fireEvent.click(await screen.findByLabelText("Remove bob@example.com"));

    const dialog = await screen.findByRole("dialog", { name: "Remove Bob?" });
    expect(dialog.textContent).toContain("Bob will lose access to this workspace");
    expect(dialog.textContent).toContain("passes to you.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);

    fireEvent.click(screen.getByLabelText("Remove bob@example.com"));
    await screen.findByRole("dialog", { name: "Remove Bob?" });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(
      await screen.findByText(
        "Removed Bob. What they owned there passed to you: 2 rooms, 1 template.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Could not revoke a GitHub sign-in.")).toBeTruthy();
  });

  it("shows organization admins read-only, and the rest manageable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              member({
                user_id: "u2",
                name: "Bob",
                email: "bob@example.com",
                can_change_role: true,
                can_remove: true,
              }),
              member({
                user_id: "u3",
                name: "Cy",
                email: "cy@example.com",
                role: "admin",
                organization_role: "org_admin",
                via_organization: true,
              }),
              member({
                user_id: "u4",
                name: "Dee",
                email: "dee@example.com",
                role: "admin",
                organization_role: "org_admin",
              }),
            ]),
          ),
      ),
    );

    render(<MembersSection tenantId="t1" selfId="u1" />);

    expect(await screen.findByText("Org admin, via organization")).toBeTruthy();
    expect(screen.getByText("Admin · Org admin")).toBeTruthy();
    expect(screen.queryByLabelText("Remove dee@example.com")).toBeNull();
    expect(screen.queryByLabelText("Role for cy@example.com")).toBeNull();
    expect(screen.queryByLabelText("Remove cy@example.com")).toBeNull();
    expect(screen.getByLabelText("Role for bob@example.com")).toBeTruthy();
    expect(screen.getByLabelText("Remove bob@example.com")).toBeTruthy();
  });
});
