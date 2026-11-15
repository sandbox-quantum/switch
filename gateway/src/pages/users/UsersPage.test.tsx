import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListedUser } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import UsersPage from "./UsersPage";

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));

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

type Answer = [number, unknown];

/** Answers each `METHOD /path` from `routes`; anything else is a 404. */
function answer(routes: Record<string, Answer>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^\/gateway/, "");
    const [status, body] = routes[`${init?.method ?? "GET"} ${path}`] ?? [
      404,
      { detail: `unmocked ${path}` },
    ];
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function openActions(email: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: `Actions for ${email}` }));
  return screen.findByRole("menu");
}

beforeEach(() => {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: "op", name: "op", email: "op@example.com", is_operator: true },
  } as unknown as ReturnType<typeof useAuth>);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("UsersPage", () => {
  it("offers to delete only the accounts the server says may be deleted", async () => {
    answer({ "GET /users": [200, [user("ada", true), user("grace", false)]] });
    render(<UsersPage />);

    const ada = await openActions("ada@example.com");
    expect(within(ada).getByRole("menuitem", { name: "Delete account" })).toBeTruthy();
    fireEvent.keyDown(ada, { key: "Escape" });

    const grace = await openActions("grace@example.com");
    expect(within(grace).queryByRole("menuitem", { name: "Delete account" })).toBeNull();
  });

  it("signs someone else out of all their devices, once confirmed", async () => {
    const fetchMock = answer({
      "GET /users": [200, [user("ada", true)]],
      "POST /users/ada/sessions/revoke": [200, { ok: true }],
    });
    render(<UsersPage />);

    const menu = await openActions("ada@example.com");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Sign out of all devices" }));
    const dialog = await screen.findByRole("dialog", { name: "Sign ada out of all devices?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign out" }));

    expect(await screen.findByText("Signed ada out of all devices.")).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).endsWith("/users/ada/sessions/revoke") && init?.method === "POST",
      ),
    ).toBe(true);
  });

  it("keeps the dialog open with the server's reason when it refuses", async () => {
    answer({
      "GET /users": [200, [user("ada", true)]],
      "POST /users/ada/sessions/revoke": [404, { detail: "User not found" }],
    });
    render(<UsersPage />);

    const menu = await openActions("ada@example.com");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Sign out of all devices" }));
    const dialog = await screen.findByRole("dialog", { name: "Sign ada out of all devices?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign out" }));

    expect(await within(dialog).findByText("User not found")).toBeTruthy();
    expect(screen.queryByText("Signed ada out of all devices.")).toBeNull();
  });

  it("leaves your own sessions to the account menu", async () => {
    answer({ "GET /users": [200, [user("op", false), user("ada", true)]] });
    render(<UsersPage />);

    await screen.findByRole("button", { name: "Actions for ada@example.com" });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Actions for op@example.com" })).toBeNull(),
    );
  });

  it("shows why the list failed to load, not an empty list", async () => {
    answer({ "GET /users": [403, { detail: "Admin access required" }] });
    render(<UsersPage />);

    expect(await screen.findByText("Admin access required")).toBeTruthy();
    expect(screen.queryByText("No users yet")).toBeNull();
  });
});
