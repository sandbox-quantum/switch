import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperatorWorkspace } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import OperatorWorkspacesPage from "./OperatorWorkspacesPage";

/** The page's search and filters on the real table: its rows do not lay out
 * in jsdom, but its count does, and the count is what the filters move. */

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));

function workspace(
  id: string,
  name: string,
  organization: { id: string; name: string | null } | null,
): OperatorWorkspace {
  return {
    id,
    slug: name.toLowerCase().replace(/ /g, "-"),
    name,
    organization_id: organization?.id ?? null,
    organization_name: organization?.name ?? null,
    archived_at: null,
  };
}

const ACME = { id: "o1", name: "Acme Group" };

beforeEach(() => {
  vi.mocked(useAuth).mockReturnValue({
    session: { tenant: { id: "t1" } },
    switchTo: vi.fn(async () => {}),
  } as unknown as ReturnType<typeof useAuth>);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            workspace("t1", "Acme Research", ACME),
            workspace("t2", "Acme Sales", ACME),
            workspace("t3", "Loose Ends", null),
          ]),
          { status: 200 },
        ),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OperatorWorkspacesPage's search and filters", () => {
  it("searches names, slugs and organizations", async () => {
    render(<OperatorWorkspacesPage />);
    expect(await screen.findByText("3 workspaces")).toBeTruthy();

    const search = screen.getByLabelText("Search workspaces");
    await act(async () => fireEvent.change(search, { target: { value: "acme-sales" } }));
    expect(screen.getByText("1 of 3 workspaces")).toBeTruthy();
    await act(async () => fireEvent.change(search, { target: { value: "acme group" } }));
    expect(screen.getByText("2 of 3 workspaces")).toBeTruthy();
  });

  it("narrows to an organization, or to the workspaces in none", async () => {
    render(<OperatorWorkspacesPage />);
    fireEvent.mouseDown(await screen.findByRole("combobox", { name: "Organization" }));
    fireEvent.click(await screen.findByRole("option", { name: "None" }));

    await waitFor(() => expect(screen.getByText("1 of 3 workspaces")).toBeTruthy());
  });
});
