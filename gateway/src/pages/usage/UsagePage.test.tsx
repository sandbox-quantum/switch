import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import UsagePage from "./UsagePage";

// The v1/v2 switch: Core's `hosted_v2` flag, read once by the page.
const hostedV2 = vi.hoisted(() => ({ value: true as boolean | null }));
vi.mock("../../data/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../data/hooks")>()),
  useCurrentTenant: () => ({
    data: { id: "t1", name: "Acme", administers: true },
    loading: false,
    error: null,
    refetch: () => {},
  }),
  useHostedV2: () => hostedV2.value,
}));

const tokens = {
  id: "b1",
  agent_id: null,
  agent_name: null,
  metric: "output_tokens",
  model: "",
  amount_limit: 9000,
  period_hours: 24,
  spent: 10,
  resets_at: "2026-11-03T00:00:00Z",
  exhausted: false,
};
const dailyCap = { ...tokens, id: "b2", metric: "hosted_ai_calls", amount_limit: 300 };
const awake = { ...tokens, id: "b3", metric: "awake_minutes", amount_limit: 600 };

function serve() {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes("/hosted-usage"))
      return new Response(
        JSON.stringify({
          since: "2026-11-01T00:00:00+00:00",
          people: [
            { user_id: "u1", name: "Sam Example", awake_hours: 2, ai_calls: 10, cap_in_force: 300, cap_source: "workspace" },
          ],
        }),
        { status: 200 },
      );
    if (url.endsWith("/budgets")) return new Response(JSON.stringify([tokens, dailyCap, awake]), { status: 200 });
    if (url.endsWith("/agents")) return new Response("[]", { status: 200 });
    if (url.endsWith("/feature-flags")) return new Response(JSON.stringify({ flags: [] }), { status: 200 });
    if (url.includes("/usage")) return new Response("[]", { status: 200 });
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function asked(fetchMock: ReturnType<typeof serve>, path: string): boolean {
  return fetchMock.mock.calls.some(([url]) => String(url).includes(path));
}

describe("the Usage page and the hosted agents v2 switch", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    hostedV2.value = true;
  });

  it("shows hosted agents' rows, the daily AI cap and awake-time budgets while v2 is on", async () => {
    const fetchMock = serve();
    render(<UsagePage />);
    expect(await screen.findByText("Hosted agents this month")).toBeTruthy();
    expect(await screen.findByText("Daily AI calls per person")).toBeTruthy();
    expect(await screen.findByText("Awake minutes")).toBeTruthy();
    expect(asked(fetchMock, "/hosted-usage")).toBe(true);
  });

  for (const [what, value] of [
    ["off", false],
    ["still being read", null],
  ] as const) {
    it(`hides hosted agents' rows, the daily AI cap and awake-time budgets, and asks for neither, while v2 is ${what}`, async () => {
      hostedV2.value = value;
      const fetchMock = serve();
      render(<UsagePage />);
      // The other budget still shows, so the page has loaded its budgets.
      expect((await screen.findAllByText("Output tokens")).length).toBeGreaterThan(0);
      await waitFor(() => expect(asked(fetchMock, "/budgets")).toBe(true));
      expect(screen.queryByText("Hosted agents this month")).toBeNull();
      expect(screen.queryByText("Daily AI calls per person")).toBeNull();
      expect(screen.queryByText("Awake minutes")).toBeNull();
      expect(asked(fetchMock, "/hosted-usage")).toBe(false);
    });
  }
});
