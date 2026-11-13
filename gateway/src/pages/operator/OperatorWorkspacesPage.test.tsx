import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperatorWorkspace } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import OperatorWorkspacesPage from "./OperatorWorkspacesPage";

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));

vi.mock("../../components/DataTable", () => import("../../test/FakeDataTable"));

const acme: OperatorWorkspace = {
  id: "t1",
  slug: "acme",
  name: "Acme",
  organization_id: "o1",
  organization_name: "Acme Group",
};

const loose: OperatorWorkspace = {
  id: "t2",
  slug: "loose",
  name: "Loose",
  organization_id: null,
  organization_name: null,
};

function answer(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

function inWorkspace(id: string) {
  vi.mocked(useAuth).mockReturnValue({
    session: { tenant: { id } },
    switchTo: vi.fn(async () => {}),
  } as unknown as ReturnType<typeof useAuth>);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OperatorWorkspacesPage", () => {
  it("lists every workspace, offering to enter all but the current one", async () => {
    inWorkspace("t1");
    answer(200, [acme, loose]);
    render(<OperatorWorkspacesPage />);

    const current = await screen.findByTestId("row-t1");
    expect(current.textContent).toContain("Acme (current)");
    expect(current.textContent).not.toContain("Enter");
    const other = screen.getByTestId("row-t2");
    expect(other.textContent).toContain("None");
    expect(other.textContent).toContain("Enter");
  });

  it("shows why the list failed to load, not an empty list", async () => {
    inWorkspace("t1");
    answer(403, { detail: "Admin access required" });
    render(<OperatorWorkspacesPage />);

    expect(await screen.findByText("Admin access required")).toBeTruthy();
    expect(screen.queryByText("No workspaces yet")).toBeNull();
  });
});
