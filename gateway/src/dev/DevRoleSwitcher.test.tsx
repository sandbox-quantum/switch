import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../data/api";
import { useAuth } from "../data/AuthContext";
import DevRoleSwitcher from "./DevRoleSwitcher";
import { type DevAccount, DEV_ROLE_ACCOUNTS_PATH, storeNote } from "./devRoleAccounts";

vi.mock("../data/AuthContext", () => ({ useAuth: vi.fn() }));

const accounts: DevAccount[] = [
  { role: "operator", label: "Operator", email: "admin@switch.local", password: "placeholder-1" },
  { role: "org_admin", label: "Org admin", email: "dev-org-admin@example.test", password: "placeholder-2" },
  {
    role: "workspace_admin",
    label: "Workspace admin",
    email: "dev-workspace-admin@example.test",
    password: "placeholder-2",
  },
  { role: "member", label: "Member", email: "dev-member@example.test", password: "placeholder-2" },
];

function sessionFor(email: string, name: string): Session {
  return {
    user: { id: "u1", name, email, is_operator: false },
    tenant: {
      id: "t1",
      slug: "default",
      name: "Default",
      role: "admin",
      organization_role: "member",
      organization_id: "o1",
    },
    tenants: [],
    state: "ready",
    can_create_workspace: false,
    can_add_workspace: false,
    invite_email_enabled: false,
  };
}

function signedIn(session: Session | null) {
  vi.mocked(useAuth).mockReturnValue({ session, loading: false } as unknown as ReturnType<
    typeof useAuth
  >);
}

function mockFetch(routes: Record<string, [number, unknown]>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    const [status, body] = routes[key] ?? [404, { detail: `unmocked ${key}` }];
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const originalLocation = window.location;
const reload = vi.fn();

beforeEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { ...originalLocation, reload },
  });
});

afterEach(() => {
  cleanup();
  reload.mockClear();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
});

describe("DevRoleSwitcher", () => {
  it("names the seeded role the session is signed in as", async () => {
    mockFetch({ [`GET ${DEV_ROLE_ACCOUNTS_PATH}`]: [200, { accounts }] });
    signedIn(sessionFor("dev-workspace-admin@example.test", "Dev Workspace Admin"));
    render(<DevRoleSwitcher />);
    expect(
      await screen.findByRole("button", { name: /Viewing as Workspace admin/ }),
    ).toBeTruthy();
  });

  it("names anyone else by their name, and says when signed out", async () => {
    mockFetch({ [`GET ${DEV_ROLE_ACCOUNTS_PATH}`]: [200, { accounts }] });
    signedIn(sessionFor("ada@example.com", "Ada"));
    const { unmount } = render(<DevRoleSwitcher />);
    expect(await screen.findByRole("button", { name: /Viewing as Ada/ })).toBeTruthy();
    unmount();
    signedIn(null);
    render(<DevRoleSwitcher />);
    expect(await screen.findByRole("button", { name: /Viewing as signed out/ })).toBeTruthy();
  });

  it("signs in as the role picked, back in the same workspace, and reloads", async () => {
    const fetchMock = mockFetch({
      [`GET ${DEV_ROLE_ACCOUNTS_PATH}`]: [200, { accounts }],
      "POST /gateway/auth/login": [200, { id: "u4" }],
      "GET /gateway/auth/session": [200, { tenant: { id: "t1" } }],
    });
    signedIn(sessionFor("admin@switch.local", "Admin"));
    render(<DevRoleSwitcher />);
    fireEvent.click(await screen.findByRole("button", { name: /Viewing as Operator/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Member/ }));

    await vi.waitFor(() => expect(reload).toHaveBeenCalled());
    const login = fetchMock.mock.calls.find(([input]) => String(input) === "/gateway/auth/login");
    expect(JSON.parse(String(login?.[1]?.body))).toEqual({
      email: "dev-member@example.test",
      password: "placeholder-2",
    });
  });

  it("shows why a sign-in failed and stays put", async () => {
    mockFetch({
      [`GET ${DEV_ROLE_ACCOUNTS_PATH}`]: [200, { accounts }],
      "POST /gateway/auth/login": [401, { detail: "Invalid email or password" }],
    });
    signedIn(sessionFor("admin@switch.local", "Admin"));
    render(<DevRoleSwitcher />);
    fireEvent.click(await screen.findByRole("button", { name: /Viewing as Operator/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Member/ }));

    expect(await screen.findByText(/Could not sign in: Invalid email or password/)).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole("menuitem", { name: /Member/ }).getAttribute("aria-disabled")).toBeNull();
  });

  it("says how to seed the accounts when there are none", async () => {
    mockFetch({});
    signedIn(null);
    render(<DevRoleSwitcher />);
    fireEvent.click(await screen.findByRole("button", { name: /Viewing as signed out/ }));
    expect(await screen.findByText(/just seed-dev-roles/)).toBeTruthy();
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("shows the note the last switch left", async () => {
    mockFetch({ [`GET ${DEV_ROLE_ACCOUNTS_PATH}`]: [200, { accounts }] });
    storeNote({ severity: "info", text: "Member can't open Second workspace." });
    signedIn(sessionFor("dev-member@example.test", "Dev Member"));
    render(<DevRoleSwitcher />);
    expect(await screen.findByText("Member can't open Second workspace.")).toBeTruthy();
  });
});
