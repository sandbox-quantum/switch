import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostedUsageSection } from "./UsagePage";

function serve(usageStatus: number, budgets: unknown[] = [], cap: Record<string, unknown> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/hosted-usage"))
        return usageStatus === 200
          ? new Response(
              JSON.stringify({
                since: "2026-10-01T00:00:00+00:00",
                people: [
                  {
                    user_id: "u1",
                    name: "Sam Example",
                    awake_hours: 41.46,
                    ai_calls: 1200,
                    cap_in_force: 200,
                    cap_source: "local",
                    ...cap,
                  },
                ],
              }),
              { status: 200 },
            )
          : new Response(JSON.stringify({ detail: "no" }), { status: usageStatus });
      if (url.endsWith("/budgets")) return new Response(JSON.stringify(budgets), { status: 200 });
      return new Response("{}", { status: 404 });
    }),
  );
}

describe("hosted agents this month (visibility L1, A3)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows each person's awake time, AI calls and the cap their box applies", async () => {
    serve(200, [
      { id: "b1", agent_id: null, metric: "hosted_ai_calls", amount_limit: 300, period_hours: 24 },
    ]);
    render(<HostedUsageSection tenantId="t1" />);
    expect(await screen.findByText("Sam Example")).toBeTruthy();
    expect(screen.getByText("41.5 h")).toBeTruthy();
    expect(screen.getByText("200 applied: Switch's own limit is lower")).toBeTruthy();
  });

  it("gives the Awake time heading room to show in full", async () => {
    serve(200);
    render(<HostedUsageSection tenantId="t1" />);
    await screen.findByText("Sam Example");
    const header = screen.getByRole("columnheader", { name: /Awake time/ });
    // The designer saw "Awake ti…" at 140 px: the heading plus the sort and menu icons need 170.
    expect(Number.parseFloat(header.style.width || header.style.minWidth)).toBeGreaterThanOrEqual(170);
  });

  it("says \"Not set\" for someone whose box reports no cap", async () => {
    serve(200, [], { cap_in_force: null, cap_source: null });
    render(<HostedUsageSection tenantId="t1" />);
    expect(await screen.findByText("Not set")).toBeTruthy();
  });

  it("asks for a reload when the read fails", async () => {
    serve(500);
    render(<HostedUsageSection tenantId="t1" />);
    expect(
      await screen.findByText("Couldn't load hosted agents' usage. Reload the page to try again."),
    ).toBeTruthy();
  });

  it("shows nothing when the server has no hosted view or refuses", async () => {
    for (const status of [403, 404, 503]) {
      serve(status);
      const { container } = render(<HostedUsageSection tenantId="t1" />);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(container.textContent).toBe("");
      cleanup();
    }
  });
});
