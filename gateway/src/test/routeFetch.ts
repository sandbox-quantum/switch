import { vi } from "vitest";

/** A reply to one gateway call: a status and a JSON body, or a function of
 * the request body for calls whose answer depends on what was sent. */
export type Reply = { status?: number; body?: unknown } | ((sent: unknown) => {
  status?: number;
  body?: unknown;
});

/**
 * Stub `fetch` with replies keyed by "METHOD /path" (the path after
 * `/gateway`, query string dropped). A reply given as a list is used in turn,
 * the last one repeating. An unexpected call fails the test rather than
 * hanging it. Returns the calls made, with their parsed bodies.
 */
export function routeFetch(routes: Record<string, Reply | Reply[]>) {
  const calls: { route: string; body: unknown }[] = [];
  const served = new Map<string, number>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace(/^\/gateway/, "").split("?")[0];
      const route = `${init?.method ?? "GET"} ${path}`;
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      calls.push({ route, body });
      const entry = routes[route];
      if (entry === undefined) throw new Error(`unexpected gateway call: ${route}`);
      const replies = Array.isArray(entry) ? entry : [entry];
      const n = served.get(route) ?? 0;
      served.set(route, n + 1);
      const reply = replies[Math.min(n, replies.length - 1)];
      const { status = 200, body: answer = {} } =
        typeof reply === "function" ? reply(body) : reply;
      return status === 204
        ? new Response(null, { status })
        : new Response(JSON.stringify(answer), { status });
    }),
  );
  return calls;
}
