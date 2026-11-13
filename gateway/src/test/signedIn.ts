import { vi } from "vitest";
import type { Session } from "../data/api";
import { useAuth } from "../data/AuthContext";
import { capabilitiesOf } from "../data/capabilities";
import { ALL_OFF, type FeatureFlags } from "../data/featureFlags";

/** Ada (`u1`), signed in to Acme as an admin of it or a member, for a test
 *  that mocks `../data/AuthContext` with `{ useAuth: vi.fn() }`. */
export function signedInAs(role: "admin" | "member", features: FeatureFlags = ALL_OFF): void {
  const tenant = {
    id: "t1",
    slug: "acme",
    name: "Acme",
    role,
    organization_role: null,
    organization_id: null,
  };
  const session = {
    user: { id: "u1", name: "Ada", email: "ada@example.com", is_operator: false },
    tenant,
    tenants: [tenant],
    state: "ready",
    can_create_workspace: false,
    can_add_workspace: false,
    invite_email_enabled: false,
  } as unknown as Session;
  vi.mocked(useAuth).mockReturnValue({
    session,
    capabilities: capabilitiesOf(
      session,
      {
        id: "t1",
        slug: "acme",
        name: "Acme",
        role,
        administers: role === "admin",
        can_delete: false,
        can_manage_data_protection: false,
      } as never,
      features,
    ),
  } as unknown as ReturnType<typeof useAuth>);
}

type Route = [number, unknown];

/** Answers `fetch` from `routes`, keyed `"METHOD /path"` without the
 *  `/gateway` prefix or the query; a list of answers is given out in turn,
 *  the last one again. Returns every call made. */
export function answer(routes: Record<string, Route | Route[]>): { method: string; path: string; body: unknown }[] {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const queues = new Map(
    Object.entries(routes).map(([key, value]) => [
      key,
      Array.isArray(value[0]) ? [...(value as Route[])] : [value as Route],
    ]),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = String(input).replace(/^\/gateway/, "").split("?")[0];
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const queue = queues.get(`${method} ${path}`);
      const [status, body] = (queue && (queue.length > 1 ? queue.shift() : queue[0])) ?? [
        404,
        { detail: `unmocked ${method} ${path}` },
      ];
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return calls;
}
