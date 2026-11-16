import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TemplateSummary } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import TemplatesPage from "./TemplatesPage";

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));

const template = (over: Partial<TemplateSummary>): TemplateSummary => ({
  id: "t-1",
  owner_id: "u-1",
  owner_name: "Ada",
  official: false,
  name: "Standup",
  description: "A daily standup room",
  kind: "room",
  read_visibility: "public",
  write_visibility: "private",
  can_edit: true,
  can_manage: true,
  run_blocked_reason: null,
  run_count: 3,
  version: 1,
  size_bytes: 10,
  created_at: "2026-11-01 09:00:00+00:00",
  updated_at: "2026-11-01 09:00:00+00:00",
  ...over,
});

const EXPERT = template({
  id: "official:switch-expert",
  owner_id: null,
  owner_name: "Switch",
  official: true,
  name: "Switch expert",
  kind: "agent",
  can_edit: false,
  can_manage: false,
  created_at: "",
  updated_at: "",
});

/** The page over a server whose catalogue answers `listing`, or fails. */
function showWith(listing: TemplateSummary[] | { status: number; detail: string }) {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: "u-1" },
    session: { tenant: { id: "ten-1", name: "Acme" } },
  } as unknown as ReturnType<typeof useAuth>);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Array.isArray(listing)
        ? new Response(JSON.stringify(listing), { status: 200 })
        : new Response(JSON.stringify({ detail: listing.detail }), { status: listing.status }),
    ),
  );
  render(
    <MemoryRouter>
      <TemplatesPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TemplatesPage", () => {
  it("puts the workspace's own templates and Switch's in tables of their own", async () => {
    showWith([EXPERT, template({ id: "a" }), template({ id: "b", name: "Retro" })]);

    expect(await screen.findByText("2 templates")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Shared templates" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Official templates" })).toBeTruthy();
    expect(screen.getByText("Maintained by Switch")).toBeTruthy();
    expect(screen.getByLabelText("Search shared templates")).toBeTruthy();
    expect(screen.getByText("Starting points for a new agent, room or group in Acme.")).toBeTruthy();
  });

  it("says the workspace has no shared templates yet, rather than showing an empty table", async () => {
    showWith([EXPERT]);
    expect(await screen.findByText("No shared templates in Acme yet")).toBeTruthy();
  });

  it("shows the server's reason the catalogue did not load, instead of the tables", async () => {
    showWith({ status: 500, detail: "database unavailable" });
    expect(await screen.findByText("Could not load templates: database unavailable")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Shared templates" })).toBeNull();
  });

  it("keeps the tables, and says why, when a refresh after an action fails", async () => {
    vi.mocked(useAuth).mockReturnValue({
      user: { id: "u-1" },
      session: { tenant: { id: "ten-1", name: "Acme" } },
    } as unknown as ReturnType<typeof useAuth>);
    let listed = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input).split("?")[0];
        const method = init?.method ?? "GET";
        if (path === "/gateway/templates" && method === "GET") {
          listed += 1;
          return listed === 1
            ? new Response(JSON.stringify([template({ id: "a" })]), { status: 200 })
            : new Response(JSON.stringify({ detail: "database unavailable" }), { status: 500 });
        }
        if (path === "/gateway/templates/validate") {
          return new Response(
            JSON.stringify({ ok: true, blocked: false, errors: [], warnings: [] }),
            { status: 200 },
          );
        }
        if (path === "/gateway/templates" && method === "POST") {
          return new Response(JSON.stringify(template({ id: "new-1", name: "Fresh" })), { status: 201 });
        }
        throw new Error(`unexpected ${method} ${path}`);
      }),
    );
    render(
      <MemoryRouter>
        <TemplatesPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText("1 template")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "New template" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Fresh" } });
    fireEvent.change(screen.getByLabelText("Document"), { target: { value: "room:\n  name: r\n" } });
    const create = screen.getByRole("button", { name: "Create" });
    await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 });
    fireEvent.click(create);

    expect(
      await screen.findByText("Could not refresh templates: database unavailable"),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Shared templates" })).toBeTruthy();
    expect(screen.getByText("1 template")).toBeTruthy();
  });

  it("lets anyone start a new template", async () => {
    showWith([]);
    expect(await screen.findByRole("button", { name: "New template" })).toBeTruthy();
  });
});
