import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MembersSection from "./MembersSection";

vi.mock("../../data/AuthContext", () => ({ useAuth: () => ({ refresh: vi.fn() }) }));

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
    // Your own row: another admin changes or removes it.
    expect(screen.queryByLabelText("Role for me@example.com")).toBeNull();
    expect(screen.queryByLabelText("Remove me@example.com")).toBeNull();
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

    expect(await screen.findByText("Org Admin, via organization")).toBeTruthy();
    expect(screen.getByText("Admin · Org Admin")).toBeTruthy();
    expect(screen.queryByLabelText("Remove dee@example.com")).toBeNull();
    expect(screen.queryByLabelText("Role for cy@example.com")).toBeNull();
    expect(screen.queryByLabelText("Remove cy@example.com")).toBeNull();
    expect(screen.getByLabelText("Role for bob@example.com")).toBeTruthy();
    expect(screen.getByLabelText("Remove bob@example.com")).toBeTruthy();
  });
});
