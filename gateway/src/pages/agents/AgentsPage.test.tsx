import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { GridColDef } from "@mui/x-data-grid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSummary } from "../../data/api";
import * as api from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import * as hooks from "../../data/hooks";
import AgentsPage from "./AgentsPage";

vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("../../data/AuthContext", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../../data/hooks", () => ({
  useAgents: vi.fn(),
}));

vi.mock("../../data/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../data/api")>();
  return { ...actual, deleteAgent: vi.fn() };
});

vi.mock("./RegisterAgentDialog", () => ({ default: () => null }));

// The data grid lays rows out from measured sizes, which jsdom does not have,
// so it renders none. This draws each row and its action cell plainly.
vi.mock("../../components/DataTable", () => ({
  default: ({ rows, columns }: { rows: AgentSummary[]; columns: GridColDef<AgentSummary>[] }) => {
    const actions = columns.find((c) => c.field === "actions");
    return (
      <div>
        {rows.map((row) => (
          <div key={row.id} data-testid={`row-${row.name}`}>
            {row.name}
            {actions?.renderCell?.({ row } as never)}
          </div>
        ))}
      </div>
    );
  },
}));

const agent = {
  id: "a1",
  name: "notes-taker",
  display_name: null,
  description: "Takes notes",
  connector_type: "claude_code",
  connection_model: "auto_session",
  tool_count: 0,
  model_count: 0,
  owner_id: "u1",
  owner_name: "ada",
  created_at: "2026-10-01T00:00:00Z",
  parent_agent_id: null,
} as unknown as AgentSummary;

async function deleteTheAgent() {
  render(<AgentsPage />);
  const row = screen.getByTestId("row-notes-taker");
  fireEvent.click(within(row).getByRole("button"));
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
}

describe("AgentsPage delete", () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { id: "u1" },
      canAdminTenant: false,
    } as unknown as ReturnType<typeof useAuth>);
    vi.mocked(hooks.useAgents).mockReturnValue({
      data: [agent],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.mocked(api.deleteAgent).mockReset();
  });

  it("warns when a chat platform's clean-up did not finish", async () => {
    vi.mocked(api.deleteAgent).mockResolvedValue({
      ok: true,
      bridge_cleanup_failures: ["slack: Slack is down"],
    });

    await deleteTheAgent();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain('Deleted "notes-taker"');
    expect(alert.textContent).toContain("slack: Slack is down");
    expect(api.deleteAgent).toHaveBeenCalledWith("a1");
  });

  it("says nothing after a clean delete", async () => {
    vi.mocked(api.deleteAgent).mockResolvedValue({ ok: true, bridge_cleanup_failures: [] });

    await deleteTheAgent();

    await waitFor(() => expect(api.deleteAgent).toHaveBeenCalledWith("a1"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
