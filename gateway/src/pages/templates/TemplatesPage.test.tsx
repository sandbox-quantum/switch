import { cleanup, render, screen } from "@testing-library/react";
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

  it("shows why the catalogue did not load instead of the tables", async () => {
    showWith({ status: 500, detail: "database unavailable" });
    expect(await screen.findByText(/Could not load templates:/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Shared templates" })).toBeNull();
  });

  it("lets anyone start a new template", async () => {
    showWith([]);
    expect(await screen.findByRole("button", { name: "New template" })).toBeTruthy();
  });
});
