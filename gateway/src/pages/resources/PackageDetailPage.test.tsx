import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PackageDetail } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { answerFetch } from "../../test/answerFetch";
import PackageDetailPage from "./PackageDetailPage";

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));

const PKG: PackageDetail = {
  id: "p1",
  owner_id: "u1",
  owner_name: "Ada",
  read_visibility: "public",
  write_visibility: "private",
  name: "Onboarding",
  description: "What a new engineer reads first.",
  instructions: "",
  references_count: 0,
  documents_count: 0,
  attached_rooms_count: 0,
  hidden_rooms_count: 0,
  created_at: "2026-10-01T00:00:00Z",
  can_read: true,
  can_edit: true,
  can_manage: true,
};

const READS = {
  "GET /packages/p1/references": [200, []],
  "GET /packages/p1/documents": [200, []],
  "GET /packages/p1/rooms": [200, []],
} as Record<string, [number, unknown]>;

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}

const show = () =>
  render(
    <MemoryRouter initialEntries={["/resources/packages/p1"]}>
      <Routes>
        <Route path="/resources/packages/:id" element={<PackageDetailPage />} />
        <Route path="/resources" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );

describe("PackageDetailPage", () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      session: { tenant: { id: "t1" } },
      capabilities: { administersWorkspace: false },
    } as unknown as ReturnType<typeof useAuth>);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("offers no hand-over or delete to someone who may only change it", async () => {
    answerFetch({ "GET /packages/p1": [200, { ...PKG, can_manage: false }], ...READS });
    show();

    await screen.findByDisplayValue("Onboarding");
    expect(screen.queryByRole("button", { name: "Transfer ownership" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete package" })).toBeNull();
  });

  it("asks before deleting, with nothing said about packages a package is not in", async () => {
    answerFetch({ "GET /packages/p1": [200, PKG], ...READS });
    show();

    fireEvent.click(await screen.findByRole("button", { name: "Delete package" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete package" });
    expect(await within(dialog).findByText(/Delete .*This cannot be undone/)).toBeTruthy();
    expect(within(dialog).queryByText(/taken out of/)).toBeNull();
  });

  it("says why it could not open, and goes back to the packages", async () => {
    answerFetch({ "GET /packages/p1": [404, { detail: "Package not found" }] });
    show();

    expect(await screen.findByText("Couldn't open this package: Package not found")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to packages" }));
    expect(screen.getByTestId("where").textContent).toBe("/resources?tab=packages");
  });
});
