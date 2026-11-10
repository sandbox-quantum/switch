import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantMembership } from "../data/api";
import { readPendingInvite, storePendingInvite } from "../data/sessionState";
import {
  type DevAccount,
  DEV_ROLE_ACCOUNTS_PATH,
  fetchDevAccounts,
  signInAs,
  storeNote,
  takeNote,
} from "./devRoleAccounts";

const member: DevAccount = {
  role: "member",
  label: "Member",
  email: "dev-member@example.test",
  password: "placeholder",
};

const second: TenantMembership = {
  id: "t2",
  slug: "second",
  name: "Second workspace",
  role: "admin",
  organization_role: "org_admin",
  organization_id: "o1",
};

type Answer = [status: number, body: unknown];

/** Answers each request from `routes` by method and path, and records it. */
function mockFetch(routes: Record<string, Answer>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    const [status, body] = routes[key] ?? [404, { detail: `unmocked ${key}` }];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function calls(fetchMock: ReturnType<typeof mockFetch>): string[] {
  return fetchMock.mock.calls.map(([input, init]) => `${init?.method ?? "GET"} ${String(input)}`);
}

function sessionIn(tenantId: string): Answer {
  return [200, { user: { id: "u3" }, tenant: { id: tenantId }, tenants: [], state: "ready" }];
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe("fetchDevAccounts", () => {
  it("reads the accounts the dev server hands out", async () => {
    mockFetch({ [`GET ${DEV_ROLE_ACCOUNTS_PATH}`]: [200, { accounts: [member] }] });
    expect(await fetchDevAccounts()).toEqual([member]);
  });

  it("answers null when nothing has been seeded", async () => {
    mockFetch({ [`GET ${DEV_ROLE_ACCOUNTS_PATH}`]: [404, "ENOENT"] });
    expect(await fetchDevAccounts()).toBeNull();
  });

  it("says so when the dev server cannot read them", async () => {
    mockFetch({ [`GET ${DEV_ROLE_ACCOUNTS_PATH}`]: [500, "EACCES: permission denied"] });
    await expect(fetchDevAccounts()).rejects.toThrow("EACCES: permission denied");
  });
});

describe("signInAs", () => {
  const signedIn: Record<string, Answer> = {
    "POST /gateway/auth/login": [200, { id: "u3" }],
  };

  beforeEach(() => {
    storePendingInvite("someone-elses-invite");
  });

  it("signs in with the account's password, and nothing more when there is no workspace", async () => {
    const fetchMock = mockFetch(signedIn);
    expect(await signInAs(member, null)).toBeNull();
    expect(calls(fetchMock)).toEqual(["POST /gateway/auth/login"]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      email: member.email,
      password: member.password,
    });
    expect(readPendingInvite()).toBeNull();
  });

  it("leaves the session alone when it already landed in the workspace", async () => {
    const fetchMock = mockFetch({ ...signedIn, "GET /gateway/auth/session": sessionIn("t2") });
    expect(await signInAs(member, second)).toBeNull();
    expect(calls(fetchMock)).not.toContain("POST /gateway/tenants/t2/switch");
  });

  it("goes back into the workspace it was viewing", async () => {
    const fetchMock = mockFetch({
      ...signedIn,
      "GET /gateway/auth/session": sessionIn("t1"),
      "POST /gateway/tenants/t2/switch": [200, {}],
    });
    expect(await signInAs(member, second)).toBeNull();
    expect(calls(fetchMock)).toContain("POST /gateway/tenants/t2/switch");
  });

  it("says when the account may not open that workspace", async () => {
    mockFetch({
      ...signedIn,
      "GET /gateway/auth/session": sessionIn("t1"),
      "POST /gateway/tenants/t2/switch": [403, { detail: "Not a member of this workspace" }],
    });
    expect(await signInAs(member, second)).toEqual({
      severity: "info",
      text: "Member can't open Second workspace.",
    });
  });

  it("reports any other failure after signing in as an error", async () => {
    mockFetch({
      ...signedIn,
      "GET /gateway/auth/session": sessionIn("t1"),
      "POST /gateway/tenants/t2/switch": [500, { detail: "database unavailable" }],
    });
    expect(await signInAs(member, second)).toEqual({
      severity: "error",
      text: "Signed in as Member, but could not go back to Second workspace: database unavailable",
    });
  });

  it("throws when the sign-in is refused, going no further", async () => {
    const fetchMock = mockFetch({
      "POST /gateway/auth/login": [401, { detail: "Invalid email or password" }],
    });
    await expect(signInAs(member, second)).rejects.toThrow("Invalid email or password");
    expect(calls(fetchMock)).toEqual(["POST /gateway/auth/login"]);
  });
});

describe("the note left for the reloaded page", () => {
  it("is read once", () => {
    storeNote({ severity: "info", text: "Member can't open Second workspace." });
    expect(takeNote()).toEqual({ severity: "info", text: "Member can't open Second workspace." });
    expect(takeNote()).toBeNull();
  });
});
