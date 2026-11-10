import { vi } from "vitest";

export type Answer = [status: number, body: unknown];

export interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** Stubs `fetch` to answer each `METHOD /path` (the path after `/gateway`)
 * from its queue, the last answer repeating, and records every call. A
 * request nobody answered gets a 404 naming it. Undo with
 * `vi.unstubAllGlobals()`. */
export function answerFetch(routes: Record<string, Answer | Answer[]>): Call[] {
  const calls: Call[] = [];
  const queues = new Map(
    Object.entries(routes).map(([key, value]) => [
      key,
      Array.isArray(value[0]) ? [...(value as Answer[])] : [value as Answer],
    ]),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = String(input).replace(/^\/gateway/, "").split("?")[0];
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null });
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
