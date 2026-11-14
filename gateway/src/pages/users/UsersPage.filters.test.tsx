import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListedUser } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import UsersPage from "./UsersPage";

/** The page's search and filters on the real table: its rows do not lay out
 * in jsdom, but its count does, and the count is what the filters move. */

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));

function user(name: string, role: "user" | "admin"): ListedUser {
  return {
    id: name,
    name,
    email: `${name.toLowerCase()}@example.com`,
    role,
    created_at: "2026-10-01T00:00:00Z",
    can_delete: role === "user",
  };
}

beforeEach(() => {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: "Op", name: "Op", email: "op@example.com", is_operator: true },
  } as unknown as ReturnType<typeof useAuth>);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify([user("Ada", "user"), user("Grace", "user"), user("Op", "admin")]),
          { status: 200 },
        ),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("UsersPage's search and filters", () => {
  it("searches names and email addresses", async () => {
    render(<UsersPage />);
    expect(await screen.findByText("3 users")).toBeTruthy();

    await act(async () =>
      fireEvent.change(screen.getByLabelText("Search users"), { target: { value: "grace@" } }),
    );
    expect(screen.getByText("1 of 3 users")).toBeTruthy();
    await act(async () =>
      fireEvent.change(screen.getByLabelText("Search users"), { target: { value: "ad" } }),
    );
    expect(screen.getByText("1 of 3 users")).toBeTruthy();
  });

  it("narrows to a role, named as the table names it", async () => {
    render(<UsersPage />);
    fireEvent.mouseDown(await screen.findByRole("combobox", { name: "Role" }));
    fireEvent.click(await screen.findByRole("option", { name: "Platform operator" }));

    await waitFor(() => expect(screen.getByText("1 of 3 users")).toBeTruthy());
  });
});
