import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as hooks from "../../data/hooks";
import BudgetDialog from "./BudgetDialog";

vi.mock("../../data/hooks", () => ({ useAgents: vi.fn() }));

describe("BudgetDialog", () => {
  beforeEach(() => {
    vi.mocked(hooks.useAgents).mockReturnValue({
      data: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof hooks.useAgents>);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("says the limit is a soft one that running work can pass", () => {
    render(<BudgetDialog tenantId="t1" budget={null} open onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(screen.getByText("A soft limit: work already running can go past it.")).toBeTruthy();
  });
});
