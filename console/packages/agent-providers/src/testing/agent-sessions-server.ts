import { vi } from 'vitest';

type Fetch = (url: string, options: RequestInit) => Promise<Response>;

/** What a host sent to the `/agent-sessions` routes, in order. */
export type AgentSessionsCall = { method: string; path: string; body: unknown };

/**
 * Stubs `fetch` with `server`, answering the `/agent-sessions` routes itself:
 * activity and approval writes are accepted, and `outcomes` (settable per
 * test) is what `GET /agent-sessions/approvals/outcomes` returns. `server`
 * never sees those calls, so a test counting its own requests is unaffected.
 * Setting `state.unavailable` answers every such call with 503, as an
 * unreachable Switch would.
 */
export function stubSwitchFetch(server: Fetch, outcomes: unknown[] = []) {
  const calls: AgentSessionsCall[] = [];
  const state = { outcomes, unavailable: false };
  vi.stubGlobal('fetch', async (url: string, options: RequestInit = {}) => {
    const path = new URL(url).pathname;
    if (!path.includes('/agent-sessions/')) return server(url, options);
    const method = options.method ?? 'GET';
    calls.push({
      method,
      path,
      body: typeof options.body === 'string' ? JSON.parse(options.body) : null,
    });
    if (state.unavailable) return new Response('unavailable', { status: 503 });
    if (path.endsWith('/approvals/outcomes')) {
      const listed = state.outcomes;
      return Response.json(listed);
    }
    if (path.endsWith('/activity')) return Response.json({ recorded: true });
    return Response.json({});
  });
  return { calls, state };
}
