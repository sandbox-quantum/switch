import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import BudgetDialog from "./BudgetDialog";

/** Core's flags default to hosted agents v2 on, as the daily-cap tests need. */
function serve(overrides: Record<string, boolean> = {}) {
  const flags: Record<string, boolean> = { hosted_v2: true, ...overrides };
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

  it("never offers the daily AI cap while hosted agents v2 is off", async () => {
    const fetchMock = serve({ hosted_v2: false });
    renderDialog();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fireEvent.mouseDown(screen.getByLabelText("Metric"));
    const list = await screen.findByRole("listbox");
    expect(within(list).getByRole("option", { name: "Output tokens" })).toBeTruthy();
    expect(within(list).queryByRole("option", { name: "Daily AI calls per person" })).toBeNull();
  });

  it("never offers awake minutes while hosted agents v2 is off, even with its flag on", async () => {
    const fetchMock = serve({ hosted_v2: false, hosted_awake_budgets: true });
    renderDialog();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fireEvent.mouseDown(screen.getByLabelText("Metric"));
    const list = await screen.findByRole("listbox");
    expect(within(list).getByRole("option", { name: "Output tokens" })).toBeTruthy();
    expect(within(list).queryByRole("option", { name: "Awake minutes" })).toBeNull();
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
    // The v2 look waits for Core's flags, so give them a moment to arrive.
    await waitFor(() => expect(screen.getByLabelText("Applies to").textContent).toBe("Every agent in the workspace"));
    expect(screen.getByText("The daily AI cap covers every person's agents.")).toBeTruthy();
  });

  it("leaves the Applies to picker as on main while hosted agents v2 is off (no raised label)", async () => {
    const fetchMock = serve({ hosted_v2: false });
    renderDialog();
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/feature-flags"))).toBe(true));
    const label = screen.getByText("Applies to", { selector: "label" });
    // Give the flags read a moment to land, then check nothing changed.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(label.className).not.toMatch(/MuiInputLabel-shrink/);
    expect(screen.getByLabelText("Applies to").textContent).not.toBe("Every agent in the workspace");
  });

  it("shows the whole-workspace choice by default when adding", async () => {
    serve();
    renderDialog();
    await waitFor(() => expect(screen.getByLabelText("Applies to").textContent).toBe("Every agent in the workspace"));
  });
});
