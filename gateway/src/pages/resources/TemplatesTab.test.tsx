import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TemplateSummary } from "../../data/api";
import TemplatesTab from "./TemplatesTab";

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

const INCIDENT = template({
  id: "official:incident",
  owner_id: null,
  owner_name: null,
  official: true,
  name: "Incident response",
  can_edit: false,
  can_manage: false,
});

function showWith(listing: TemplateSummary[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(listing), { status: 200 })),
  );
  render(
    <MemoryRouter>
      <TemplatesTab refreshKey={0} />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TemplatesTab", () => {
  it("lists Switch's templates beside the workspace's, marked Official and owned by Switch", async () => {
    showWith([INCIDENT, template({})]);

    const official = (await screen.findByText("Incident response")).closest('[role="row"]') as HTMLElement;
    expect(within(official).getByText("Official")).toBeTruthy();
    expect(within(official).getByText("Switch")).toBeTruthy();

    const own = screen.getByText("Standup").closest('[role="row"]') as HTMLElement;
    expect(within(own).queryByText("Official")).toBeNull();
    expect(within(own).getByText("Ada")).toBeTruthy();
  });
  it("keeps a long name on one line, with the whole name on hover, and the Official chip in full", async () => {
    const name = "A very long official template name that will not fit in the column";
    showWith([{ ...INCIDENT, name }]);

    const cell = await screen.findByText(name);
    expect(cell.getAttribute("title")).toBe(name);
    expect(cell.style.whiteSpace === "nowrap" || getComputedStyle(cell).whiteSpace === "nowrap").toBe(true);
    const official = within(cell.closest('[role="row"]') as HTMLElement).getByText("Official");
    expect(getComputedStyle(official.closest(".MuiChip-root") as HTMLElement).flexShrink).toBe("0");
  });
});
