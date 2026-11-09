import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { GridColDef } from "@mui/x-data-grid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSummary } from "../../data/api";
import * as api from "../../data/api";
import * as hooks from "../../data/hooks";
import AgentsPage from "./AgentsPage";

vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("../../data/hooks", () => ({
  useAgents: vi.fn(),
  useHostedV2: vi.fn(() => false),
}));

vi.mock("../../data/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../data/api")>();
  return { ...actual, deleteAgent: vi.fn() };
});

vi.mock("./RegisterAgentDialog", () => ({ default: () => null }));
// The logins section has tests of its own; here it would add its own reads.
// It's drawn as an empty section, so a status line's link has somewhere to go.
vi.mock("./cloud/CloudLoginsSection", () => ({
  AI_LOGINS_ID: "cloud-ai-logins",
  default: ({
    agentProviders,
    ask,
    onLoginSet,
  }: {
    agentProviders?: (string | null)[];
    ask?: { provider: string } | null;
    onLoginSet?: (tick: { set: boolean; missing: string | null }) => void;
  }) => (
    <section
      id="cloud-ai-logins"
      tabIndex={-1}
      aria-label="AI logins on your cloud"
      data-providers={JSON.stringify(agentProviders ?? [])}
      data-ask={ask?.provider ?? ""}
    >
      <button onClick={() => onLoginSet?.({ set: false, missing: "claude" })}>report Claude missing</button>
    </section>
  ),
}));
// The cloud delete has tests of its own; here it only shows which agent it opened for.
vi.mock("./cloud/CloudDeleteDialog", () => ({
  default: ({ agent }: { agent: { name: string } | null }) =>
    agent ? <div data-testid="cloud-delete">{agent.name}</div> : null,
}));

// The data grid lays rows out from measured sizes, which jsdom does not have,
// so it renders none. This draws each row and its action cell plainly.
vi.mock("../../components/DataTable", () => ({
  default: ({ rows, columns }: { rows: AgentSummary[]; columns: GridColDef<AgentSummary>[] }) => {
    const actions = columns.find((c) => c.field === "actions");
    const cloud = columns.find((c) => c.field === "cloud_status");
    const name = columns.find((c) => c.field === "name");
    return (
      <div>
        {columns.map((c) => (
          <span key={c.field} data-testid="column">
            {c.headerName}
          </span>
        ))}
        {rows.map((row) => (
          <div key={row.id} data-testid={`row-${row.name}`}>
            <span data-testid="name">
              {name?.valueGetter
                ? String((name.valueGetter as (v: unknown, r: AgentSummary) => unknown)(row.name, row))
                : row.name}
            </span>
            {cloud && <span data-testid="cloud">{cloud.renderCell?.({ row } as never)}</span>}
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
  can_manage: true,
} as unknown as AgentSummary;

async function deleteTheAgent() {
  render(<AgentsPage />);
  const row = screen.getByTestId("row-notes-taker");
  fireEvent.click(within(row).getByRole("button"));
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
}

describe("AgentsPage delete", () => {
  beforeEach(() => {
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

describe("AgentsPage with hosted agents v2", () => {
  // A resting box with agents: Core's per-agent states show in the column.
  const resting = {
    machine_id: "m-1",
    state: "stopped",
    desired_state: "running",
    stop_reason: null,
    sleeping: true,
    revision: 1,
    agents: ["a1", "a2"],
    controller_id: "c-1",
    backend: "box",
    room: null,
    awake: null,
    ai_calls_today: null,
  };
  const others = [
    agent,
    { ...agent, id: "a2", name: "stopped-one", display_name: "Stopped one" },
    { ...agent, id: "a3", name: "<b>local</b>" },
  ] as AgentSummary[];
  let fetch: ReturnType<typeof vi.fn>;
  let box: Record<string, unknown>;

  beforeEach(() => {
    box = resting;
    vi.mocked(hooks.useAgents).mockReturnValue({
      data: others,
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    fetch = vi.fn(async (url: string) => {
      const body = url.endsWith("/hosted-machines")
        ? { available: true, machines: [box] }
        : { available: true, agents: [{ agent_id: "a1", state: "resting", box_stopped: true }] };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.mocked(hooks.useHostedV2).mockReturnValue(false);
  });

  it("with v2 off, shows no panel or Cloud column and asks nothing", async () => {
    vi.mocked(hooks.useHostedV2).mockReturnValue(false);
    render(<AgentsPage />);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.queryByRole("region", { name: "Your cloud" })).toBeNull();
    expect(screen.queryByText("Your cloud")).toBeNull();
    expect(screen.getAllByTestId("column").map((c) => c.textContent)).not.toContain("Cloud");
    expect(screen.queryAllByTestId("cloud")).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
    // The Name column is as upstream: the name, never the display name.
    expect(within(screen.getByTestId("row-stopped-one")).getByTestId("name").textContent).toBe(
      "stopped-one",
    );
  });

  it("with v2 on, names each agent by its display name, as Console does", async () => {
    vi.mocked(hooks.useHostedV2).mockReturnValue(true);
    render(<AgentsPage />);
    await screen.findByText("Your cloud");
    expect(within(screen.getByTestId("row-stopped-one")).getByTestId("name").textContent).toBe(
      "Stopped one",
    );
    // No display name: the name.
    expect(within(screen.getByTestId("row-notes-taker")).getByTestId("name").textContent).toBe(
      "notes-taker",
    );
  });

  it("says Stopped for every agent on a box the panel shows as Stopped", async () => {
    box = { ...resting, state: "retained", desired_state: "retained", sleeping: false };
    vi.mocked(hooks.useHostedV2).mockReturnValue(true);
    render(<AgentsPage />);
    expect(await screen.findByText("Start it to add or use an agent.")).toBeTruthy();
    await waitFor(() =>
      expect(within(screen.getByTestId("row-notes-taker")).getByTestId("cloud").textContent).toBe(
        "Stopped · Start your cloud to use it",
      ),
    );
    // Its owner stopped it, so Core sends no state: on a stopped box it still says to start the cloud.
    expect(within(screen.getByTestId("row-stopped-one")).getByTestId("cloud").textContent).toBe(
      "Stopped · Start your cloud to use it",
    );
    // An agent not on the box is left alone.
    expect(within(screen.getByTestId("row-<b>local</b>")).getByTestId("cloud").textContent).toBe("—");
  });

  it("an agent with no working login says so, and its Check your AI login goes to the AI logins", async () => {
    box = { ...resting, state: "ready", sleeping: false };
    fetch.mockImplementation(async (url: string) => {
      const body = url.endsWith("/hosted-machines")
        ? { available: true, machines: [box] }
        : { agents: [{ agent_id: "a1", state: "unavailable", stop_reason: "login_needed" }] };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.mocked(hooks.useHostedV2).mockReturnValue(true);
    render(<AgentsPage />);
    const cell = await waitFor(() => {
      const found = within(screen.getByTestId("row-notes-taker")).getByTestId("cloud");
      expect(found.textContent).toBe("Can't reply right now · Check your AI login");
      return found;
    });
    fireEvent.click(within(cell).getByRole("button", { name: "Check your AI login" }));
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "AI logins on your cloud" }));
  });

  it("hands the logins each box agent's provider, and Give login asks for the one missing", async () => {
    box = { ...resting, state: "ready", sleeping: false };
    vi.mocked(hooks.useAgents).mockReturnValue({
      data: [
        { ...agent, known_agent_type: "claude-code" },
        { ...agent, id: "a2", name: "coder", known_agent_type: "codex" },
        { ...agent, id: "a3", name: "<b>local</b>", known_agent_type: "claude-code" },
      ] as AgentSummary[],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    vi.mocked(hooks.useHostedV2).mockReturnValue(true);
    render(<AgentsPage />);
    const logins = await screen.findByRole("region", { name: "AI logins on your cloud" });
    // Only the agents on the box (a1, a2), in the box's order.
    expect(logins.getAttribute("data-providers")).toBe(JSON.stringify(["claude", "codex"]));
    fireEvent.click(screen.getByRole("button", { name: "report Claude missing" }));
    fireEvent.click(await screen.findByRole("button", { name: "Give login" }));
    expect(logins.getAttribute("data-ask")).toBe("claude");
    expect(document.activeElement).toBe(logins);
  });

  it("shows no checklist while the agents list is still loading, then shows it", async () => {
    box = { ...resting, state: "ready", sleeping: false, agents: [] };
    const loadingAgents = { data: null, loading: true, error: null, refetch: vi.fn() };
    vi.mocked(hooks.useAgents).mockReturnValue(loadingAgents as never);
    vi.mocked(hooks.useHostedV2).mockReturnValue(true);
    const { rerender } = render(<AgentsPage />);
    await screen.findByRole("region", { name: "AI logins on your cloud" });
    fireEvent.click(screen.getByRole("button", { name: "report Claude missing" }));
    expect(screen.queryByRole("list", { name: "Setting up your cloud" })).toBeNull();
    vi.mocked(hooks.useAgents).mockReturnValue({ data: others, loading: false, error: null, refetch: vi.fn() });
    rerender(<AgentsPage />);
    expect(await screen.findByRole("list", { name: "Setting up your cloud" })).toBeTruthy();
  });

  it("puts a cloud state and its detail on two lines, never cut off, with the whole on hover", async () => {
    box = { ...resting, state: "ready", sleeping: false };
    fetch.mockImplementation(async (url: string) => {
      const body = url.endsWith("/hosted-machines")
        ? { available: true, machines: [box] }
        : { agents: [{ agent_id: "a1", state: "waking", box_starting: true, last_reply_at: "2026-11-05T11:56:00Z" }] };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.mocked(hooks.useHostedV2).mockReturnValue(true);
    render(<AgentsPage />);
    const cell = await waitFor(() => {
      const found = within(screen.getByTestId("row-notes-taker")).getByTestId("cloud-cell");
      expect(found.textContent).toBe("Back in a moment · Starting your cloud");
      return found;
    });
    // One line each: the state, then its detail.
    const lines = [...cell.querySelectorAll(":scope > div > div")].map((line) => line.textContent);
    expect(lines).toEqual(["Back in a moment", " · Starting your cloud"]);
    expect(cell.getAttribute("title")).toMatch(/^Back in a moment · Starting your cloud \(last reply .+\)$/);
  });

  it("keeps main's header button with v2 off, and groups it only with v2 on", async () => {
    vi.mocked(hooks.useHostedV2).mockReturnValue(false);
    const { unmount } = render(<AgentsPage />);
    const heading = screen.getByRole("heading", { name: "Agents" });
    // Main: the button sits straight in the header row, beside the heading.
    expect(screen.getByRole("button", { name: "Add agent" }).parentElement).toBe(heading.parentElement);
    unmount();
    vi.mocked(hooks.useHostedV2).mockReturnValue(true);
    render(<AgentsPage />);
    await screen.findByText("Your cloud");
    const button = screen.getByRole("button", { name: "Add agent" });
    expect(button.parentElement).not.toBe(screen.getByRole("heading", { name: "Agents" }).parentElement);
  });

  it("while the flag is still loading, shows and asks nothing", async () => {
    vi.mocked(hooks.useHostedV2).mockReturnValue(null);
    render(<AgentsPage />);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.queryByText("Your cloud")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("with v2 on, shows the panel and each agent's cloud state", async () => {
    vi.mocked(hooks.useHostedV2).mockReturnValue(true);
    render(<AgentsPage />);

    expect(await screen.findByText("Your cloud")).toBeTruthy();
    expect(screen.getByText("Starts when you message an agent.")).toBeTruthy();
    expect(screen.getAllByTestId("column").map((c) => c.textContent)).toContain("Cloud");
    await waitFor(() =>
      expect(within(screen.getByTestId("row-notes-taker")).getByTestId("cloud").textContent).toBe(
        "Resting · Starts when messaged",
      ),
    );
    expect(within(screen.getByTestId("row-stopped-one")).getByTestId("cloud").textContent).toBe(
      "Stopped",
    );
    const local = screen.getByTestId("row-<b>local</b>");
    expect(within(local).getByTestId("cloud").textContent).toBe("—");
    expect(local.querySelector("b")).toBeNull();
    const urls = fetch.mock.calls.map((call) => call[0]);
    expect(new Set(urls)).toEqual(
      new Set(["/gateway/hosted-machines", "/gateway/shared-cloud/agents"]),
    );
  });

  it("deletes an agent on the box through the cloud delete, and any other agent as before", async () => {
    vi.mocked(hooks.useHostedV2).mockReturnValue(true);
    render(<AgentsPage />);
    await screen.findByText("Your cloud");
    await waitFor(() => expect(within(screen.getByTestId("row-notes-taker")).getByRole("button")).toBeTruthy());
    fireEvent.click(within(screen.getByTestId("row-notes-taker")).getByRole("button"));
    expect((await screen.findByTestId("cloud-delete")).textContent).toBe("notes-taker");
    expect(screen.queryByText("Delete agent")).toBeNull();
    cleanup();
    render(<AgentsPage />);
    await screen.findByText("Your cloud");
    fireEvent.click(within(screen.getByTestId("row-<b>local</b>")).getByRole("button"));
    expect(await screen.findByText("Delete agent")).toBeTruthy();
    expect(screen.queryByTestId("cloud-delete")).toBeNull();
  });

  it("offers Add agent on Switch cloud from the same read, where a box is available", async () => {
    vi.mocked(hooks.useHostedV2).mockReturnValue(true);
    render(<AgentsPage />);
    expect(await screen.findByRole("button", { name: "Add agent on Switch cloud" })).toBeTruthy();
    // One hosted-machines read feeds both the panel and the button.
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const reads = fetch.mock.calls.filter((call) => call[0] === "/gateway/hosted-machines");
    expect(reads).toHaveLength(1);
  });

  it("doesn't offer it where this workspace may not have a box", async () => {
    fetch.mockImplementation(async (url: string) =>
      new Response(
        JSON.stringify(url.endsWith("/hosted-machines") ? { available: false, machines: [] } : { agents: [] }),
        { status: 200 },
      ),
    );
    vi.mocked(hooks.useHostedV2).mockReturnValue(true);
    render(<AgentsPage />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("button", { name: "Add agent on Switch cloud" })).toBeNull();
  });

  it("with v2 off, doesn't offer it", async () => {
    vi.mocked(hooks.useHostedV2).mockReturnValue(false);
    render(<AgentsPage />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("button", { name: "Add agent on Switch cloud" })).toBeNull();
  });
});
