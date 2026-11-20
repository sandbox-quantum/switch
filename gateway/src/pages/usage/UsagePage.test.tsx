import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { answer } from "../../test/signedIn";
import UsagePage from "./UsagePage";

vi.mock("../../components/DataTable", () => import("../../test/FakeDataTable"));

const ADMIN_OF_ACME = {
  id: "t1",
  slug: "acme",
  name: "Acme",
  role: "admin",
  administers: true,
  can_delete: false,
  can_manage_data_protection: false,
};

const BUDGET = {
  id: "b1",
  agent_id: null,
  agent_name: null,
  metric: "output_tokens",
  model: "",
  amount_limit: 1000,
  period_hours: 24,
  spent: 0,
  resets_at: "2026-11-18T00:00:00Z",
  exhausted: false,
};

describe("UsagePage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("is titled Usage & budget, without the workspace's name", async () => {
    answer({
      "GET /tenants/current": [200, ADMIN_OF_ACME],
      "GET /tenants/t1/budgets": [200, []],
      "GET /tenants/t1/usage": [200, []],
      "GET /agents": [200, []],
    });
    render(<UsagePage />);
    expect(await screen.findByRole("heading", { name: "Usage & budget" })).toBeTruthy();
    expect(screen.queryByText(/Usage · Acme/)).toBeNull();
  });

  it("opens the Add budget dialog, and adds the budget filled in there", async () => {
    const calls = answer({
      "GET /tenants/current": [200, ADMIN_OF_ACME],
      "GET /tenants/t1/budgets": [[200, []], [200, [BUDGET]]],
      "GET /tenants/t1/usage": [200, []],
      "GET /agents": [200, []],
      "POST /tenants/t1/budgets": [201, BUDGET],
    });
    render(<UsagePage />);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Add budget" }));
    const dialog = await screen.findByRole("dialog", { name: "Add budget" });

    fireEvent.change(within(dialog).getByLabelText(/^Limit/), { target: { value: "1000" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      agent_id: null,
      metric: "output_tokens",
      model: "",
      amount_limit: 1000,
      period_hours: 24,
    });
  });
});
