import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ListedUser } from "../../data/api";
import UsersPage from "./UsersPage";

vi.mock("../../components/DataTable", () => import("../../test/FakeDataTable"));

function user(id: string, can_delete: boolean): ListedUser {
  return {
    id,
    name: id,
    email: `${id}@example.com`,
    role: "user",
    created_at: "2026-10-01T00:00:00Z",
    can_delete,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("UsersPage", () => {
  it("offers to delete only the accounts the server says may be deleted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify([user("ada", true), user("op", false)]), { status: 200 }),
      ),
    );
    render(<UsersPage />);

    expect(await screen.findByRole("button", { name: "Delete ada@example.com" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete op@example.com" })).toBeNull();
  });

  it("shows why the list failed to load, not an empty list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: "Admin access required" }), { status: 403 }),
      ),
    );
    render(<UsersPage />);

    expect(await screen.findByText("Admin access required")).toBeTruthy();
    expect(screen.queryByText("No users yet")).toBeNull();
  });
});
