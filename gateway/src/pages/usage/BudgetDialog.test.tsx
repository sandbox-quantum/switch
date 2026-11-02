import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import BudgetDialog from "./BudgetDialog";

function serve(flags: Record<string, boolean> = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/feature-flags"))
      return new Response(
        JSON.stringify({ flags: Object.entries(flags).map(([key, enabled]) => ({ key, enabled })) }),
        { status: 200 },
      );
    if (url.endsWith("/agents")) return new Response("[]", { status: 200 });
    if (url.endsWith("/budgets") && init?.method === "POST")
      return new Response(JSON.stringify({ id: "b1" }), { status: 201 });
    return new Response("[]", { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function chooseMetric(label: string) {
  fireEvent.mouseDown(screen.getByLabelText("Metric"));
  fireEvent.click(await screen.findByRole("option", { name: label }));
}

function renderDialog() {
  render(
    <BudgetDialog tenantId="t1" budget={null} open onClose={() => {}} onSaved={() => {}} />,
  );
}

describe("adding a budget on hosted metrics", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("offers awake minutes only while the server's flag is on", async () => {
    const fetchMock = serve({ hosted_awake_budgets: false });
    renderDialog();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fireEvent.mouseDown(screen.getByLabelText("Metric"));
    const list = await screen.findByRole("listbox");
    expect(within(list).queryByRole("option", { name: "Awake minutes" })).toBeNull();
    expect(within(list).getByRole("option", { name: "Daily AI calls per person" })).toBeTruthy();
  });

  it("offers awake minutes when the flag is on", async () => {
    serve({ hosted_awake_budgets: true });
    renderDialog();
    fireEvent.mouseDown(screen.getByLabelText("Metric"));
    expect(await screen.findByRole("option", { name: "Awake minutes" })).toBeTruthy();
  });

  it("locks the daily AI cap to every agent and a day, and holds it to 50 to 5,000", async () => {
    const fetchMock = serve();
    renderDialog();
    await chooseMetric("Daily AI calls per person");
    expect(screen.getByText(/can make up to this many AI calls a day/)).toBeTruthy();
    expect((screen.getByLabelText(/Period/) as HTMLInputElement).disabled).toBe(true);
    const limit = screen.getByLabelText(/Limit/);
    const add = screen.getByRole("button", { name: "Add" });
    for (const bad of ["40", "5001"]) {
      fireEvent.change(limit, { target: { value: bad } });
      expect(screen.getByText("Choose between 50 and 5,000 a day.")).toBeTruthy();
      expect((add as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.change(limit, { target: { value: "300" } });
    fireEvent.click(add);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST"),
      ).toBe(true),
    );
    const [, init] = fetchMock.mock.calls.find(
      ([, i]) => (i as RequestInit | undefined)?.method === "POST",
    ) as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      agent_id: null,
      metric: "hosted_ai_calls",
      model: "",
      amount_limit: 300,
      period_hours: 24,
    });
  });

  it("shows the locked whole-workspace choice when editing the daily AI cap", async () => {
    // Designer's fix list, item 6: "Applies to" showed blank for the daily cap.
    serve();
    render(
      <BudgetDialog
        tenantId="t1"
        budget={{
          id: "b1",
          agent_id: null,
          agent_name: null,
          metric: "hosted_ai_calls",
          model: "",
          amount_limit: 2000,
          period_hours: 24,
          spent: 0,
          resets_at: "2026-10-31T00:00:00Z",
          exhausted: false,
        }}
        open
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    const appliesTo = screen.getByLabelText("Applies to");
    expect(appliesTo.textContent).toBe("Every agent in the workspace");
    expect(screen.getByText("The daily AI cap covers every person's agents.")).toBeTruthy();
  });

  it("shows the whole-workspace choice by default when adding", async () => {
    serve();
    renderDialog();
    expect(screen.getByLabelText("Applies to").textContent).toBe("Every agent in the workspace");
  });
});
