import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { Link, RouterProvider, createMemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedAgentView } from "@switch-console/chat-ui/client/agents-client";
import type { AgentDetail } from "../../data/api";
import { AgentConnectorsView, AgentSettingsView } from "./AgentSettingsView";

const api = vi.hoisted(() => ({
  fetchAgent: vi.fn(),
  updateAgentDisplayName: vi.fn(),
  updateAgentDescription: vi.fn(),
  updateAgentCanManageAgents: vi.fn(),
  updateAgentMidTurnDelivery: vi.fn(),
  deleteAgent: vi.fn(),
}));
vi.mock("../../data/api", () => api);

const management = vi.hoisted(() => ({ fetchProviders: vi.fn(), fetchControllers: vi.fn() }));
vi.mock("../../data/management", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../data/management")>()),
  ...management,
}));

const agentsClient = vi.hoisted(() => ({ getManagedAgent: vi.fn(), updateManagedAgent: vi.fn() }));
vi.mock("../../data/useManagedAgent", () => ({ agentsClient }));

const features = vi.hoisted(() => ({ value: { agent_management: true } as Record<string, boolean> }));
vi.mock("../../data/AuthContext", () => ({
  useAuth: () => ({ capabilities: { features: features.value } }),
}));

vi.mock("../agents/AddressingPolicySection", () => ({
  default: () => <div>Who can talk to your agent</div>,
}));
vi.mock("../agents/ServiceAccessSection", () => ({
  default: () => <div data-testid="service-access">Service access</div>,
}));
vi.mock("@switch-console/chat-ui/host", () => ({
  AgentAvatar: ({ name }: { name: string }) => <div>Avatar: {name}</div>,
}));

function detail(overrides: Partial<AgentDetail> = {}): AgentDetail {
  return {
    id: "agent-1",
    name: "pm-agent",
    display_name: null,
    icon_url: null,
    description: "Writes PRDs",
    can_manage: true,
    can_widen_addressing: true,
    can_change_manage_agents: true,
    can_grant_services: true,
    addressing_policy: { rules: [] },
    mid_turn_delivery: "steer",
    can_manage_agents: false,
    ...overrides,
  } as AgentDetail;
}

function managed(overrides: Partial<ManagedAgentView> = {}): ManagedAgentView {
  return {
    agent_id: "agent-1",
    name: "pm-agent",
    display_name: null,
    icon_url: null,
    description: "Writes PRDs",
    controller_id: "device-1",
    controller_name: "laptop",
    controller_kind: "daemon",
    controller_state: "online",
    desired_state: "running",
    revision: 1,
    definition: {
      provider: "claude",
      model: "opus",
      instructions: "Be brief.",
      auto_mode: true,
      auto_approve: false,
      directory: "/work/pm",
      isolation: "shared",
      advanced_config: { effort: "high", legacy: "kept" },
    },
    status: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    can_edit: true,
    can_delete: true,
    ...overrides,
  };
}

const PROVIDERS = [
  {
    id: "claude",
    label: "Claude Code",
    advanced_fields: [
      { key: "effort", label: "Effort", type: "text", help: null, placeholder: null, options: null, catalogue: null },
      { key: "tools", label: "Tools", type: "list", help: null, placeholder: null, options: null, catalogue: null },
    ],
  },
  { id: "cursor", label: "Cursor", advanced_fields: [] },
];

const onMove = vi.fn();
const onManagedChanged = vi.fn();

function renderSettings(agent: AgentDetail, managedAgent: ManagedAgentView | null, move: (() => void) | null = onMove) {
  api.fetchAgent.mockResolvedValue(agent);
  const router = createMemoryRouter(
    [
      {
        path: "/chats/agents/agent-1",
        element: (
          <>
            <Link to="/elsewhere">Somewhere else</Link>
            <AgentSettingsView
              agentId="agent-1"
              managedAgent={managedAgent}
              onManagedChanged={onManagedChanged}
              onMove={move}
            />
          </>
        ),
      },
      { path: "/elsewhere", element: <p>Elsewhere</p> },
      { path: "/agents", element: <p>Agents list</p> },
    ],
    { initialEntries: ["/chats/agents/agent-1?section=settings"] },
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

async function editDescription(user: ReturnType<typeof userEvent.setup>, value: string) {
  await user.click(await screen.findByRole("button", { name: "Edit description" }));
  const box = screen.getByRole("textbox", { name: "Description" });
  await user.clear(box);
  await user.type(box, value);
  await user.keyboard("{Enter}");
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  features.value = { agent_management: true };
  for (const fn of Object.values(api)) fn.mockReset().mockResolvedValue({});
  management.fetchProviders.mockReset().mockResolvedValue(PROVIDERS);
  management.fetchControllers.mockReset().mockResolvedValue([]);
  agentsClient.getManagedAgent.mockReset().mockResolvedValue(managed());
  agentsClient.updateManagedAgent.mockReset().mockResolvedValue({});
  onMove.mockReset();
  onManagedChanged.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AgentSettingsView", () => {
  it("lays out a managed agent the way Console's agent page does", async () => {
    renderSettings(detail(), managed());
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toContain("pm-agent");
    expect(screen.getByText("Writes PRDs")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: /Agent instructions/ }) as HTMLTextAreaElement).value).toBe("Be brief.");
    expect(screen.getByRole("heading", { level: 2, name: "General" })).toBeTruthy();
    for (const row of ["Auto mode", "Bypass permissions", "Can manage agents", "Who can talk to your agent", "Directory", "Run in its own process"])
      expect(screen.getAllByText(row).length).toBeGreaterThan(0);
    expect(screen.getByText("Runs on laptop.")).toBeTruthy();
    expect(await screen.findByText("Claude Code")).toBeTruthy();
    expect((screen.getByRole("button", { name: /^Advanced configuration/ })).textContent).toContain("opus · high");
    expect(screen.getByRole("heading", { level: 2, name: "Danger zone" })).toBeTruthy();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("saves the description, instructions and an advanced setting together from the save bar, changing only what was edited", async () => {
    const user = userEvent.setup();
    renderSettings(detail(), managed());
    await screen.findByText("Claude Code");
    await editDescription(user, "Writes specs");
    const instructions = screen.getByRole("textbox", { name: /Agent instructions/ });
    await user.clear(instructions);
    await user.type(instructions, "Be thorough.");
    await user.click(screen.getByRole("button", { name: /^Advanced configuration/ }));
    await user.type(screen.getByLabelText("Tools (optional)"), "Read, Grep");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(agentsClient.updateManagedAgent).toHaveBeenCalledWith("agent-1", {
        definition: {
          ...managed().definition,
          instructions: "Be thorough.",
          advanced_config: { legacy: "kept", effort: "high", tools: ["Read", "Grep"] },
        },
      }),
    );
    expect(api.updateAgentDescription).toHaveBeenCalledWith("agent-1", "Writes specs");
    expect(api.updateAgentDisplayName).not.toHaveBeenCalled();
    expect(onManagedChanged).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
  });

  it("shows Switch's refusal and saves nothing else", async () => {
    const user = userEvent.setup();
    agentsClient.updateManagedAgent.mockRejectedValue(new Error("Claude Code is not signed in on laptop."));
    renderSettings(detail(), managed());
    await screen.findByText("Claude Code");
    await editDescription(user, "Writes specs");
    await user.click(screen.getByRole("switch", { name: "Bypass permissions" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Claude Code is not signed in on laptop.");
    expect(api.updateAgentDescription).not.toHaveBeenCalled();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });

  it("asks before leaving with unsaved changes, and stays or discards as told", async () => {
    const user = userEvent.setup();
    const router = renderSettings(detail(), managed());
    await editDescription(user, "Writes specs");

    await user.click(screen.getByRole("link", { name: "Somewhere else" }));
    const dialog = await screen.findByRole("dialog");
    expect((dialog).textContent).toContain("You have unsaved changes");
    await user.click(within(dialog).getByRole("button", { name: "Stay" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(router.state.location.pathname).toBe("/chats/agents/agent-1");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    await user.click(screen.getByRole("link", { name: "Somewhere else" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Discard and leave" }));
    expect(await screen.findByText("Elsewhere")).toBeTruthy();
  });

  it("leaves without asking when nothing is unsaved", async () => {
    const user = userEvent.setup();
    renderSettings(detail(), managed());
    await screen.findByText("Claude Code");
    await user.click(screen.getByRole("link", { name: "Somewhere else" }));
    expect(await screen.findByText("Elsewhere")).toBeTruthy();
  });

  it("moves the agent from the Device row", async () => {
    const user = userEvent.setup();
    renderSettings(detail(), managed());
    await user.click(await screen.findByRole("button", { name: "Change…" }));
    expect(onMove).toHaveBeenCalled();
  });

  it("shows an agent on Switch Cloud as running there, with no device to change to", async () => {
    renderSettings(detail(), managed({ controller_kind: "ec2", controller_name: "i-0abc" }), null);
    expect(await screen.findByText("Runs on Switch Cloud.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change…" })).toBeNull();
    expect(screen.queryByText(/i-0abc/)).toBeNull();
    expect(
      screen.getByText("Switch Cloud runs every agent as a user of its own, apart from the other agents and the device's controller."),
    ).toBeTruthy();
  });

  it("says device where Console says machine", async () => {
    renderSettings(detail({ display_name: "PM" }), managed({ display_name: "PM" }));
    expect(await screen.findByText((_, el) => el?.tagName === "P" && el.textContent === "Name: pm-agent")).toBeTruthy();
    expect(screen.getByText("Keep it apart from the other agents on its device.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\bmachines?\b/i);
  });

  it("offers no auto mode for a provider without its own review", async () => {
    renderSettings(detail(), managed({ definition: { ...managed().definition, provider: "cursor" } }));
    expect(await screen.findByText("Bypass permissions")).toBeTruthy();
    expect(screen.queryByText("Auto mode")).toBeNull();
  });

  it("deletes the agent from the danger zone once confirmed", async () => {
    const user = userEvent.setup();
    renderSettings(detail(), managed());
    await user.click(await screen.findByRole("button", { name: "Delete agent…" }));
    const dialog = await screen.findByRole("dialog");
    expect((dialog).textContent).toContain("Delete pm-agent?");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteAgent).toHaveBeenCalledWith("agent-1"));
    expect(await screen.findByText("Agents list")).toBeTruthy();
  });

  it("shows an agent Switch does not run with its identity and the rows Switch holds, saved from the bar", async () => {
    const user = userEvent.setup();
    renderSettings(detail(), null);
    expect(await screen.findByText("Who can talk to your agent")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /Agent instructions/ })).toBeNull();
    expect(screen.queryByText("Directory")).toBeNull();
    expect(screen.queryByText("Danger zone")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Edit display name" }));
    await user.type(screen.getByRole("textbox", { name: "Display name" }), "PM");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.updateAgentDisplayName).toHaveBeenCalledWith("agent-1", "PM"));
    expect(agentsClient.updateManagedAgent).not.toHaveBeenCalled();
  });

  it("saves steering as soon as it is switched", async () => {
    const user = userEvent.setup();
    renderSettings(detail(), null);
    await user.click(await screen.findByRole("switch", { name: "Steer messages sent while it works" }));
    await waitFor(() => expect(api.updateAgentMidTurnDelivery).toHaveBeenCalledWith("agent-1", "queue"));
  });

  it("is read-only for someone who cannot change the agent", async () => {
    renderSettings(detail({ can_manage: false, can_change_manage_agents: false }), null);
    expect(await screen.findByText(/only its owner and this workspace's admins can change it/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit description" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit display name" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Steer messages sent while it works" }).hasAttribute("data-disabled")).toBe(true);
    expect(screen.getByRole("switch", { name: "Can manage agents" }).hasAttribute("data-disabled")).toBe(true);
  });
});

describe("AgentConnectorsView", () => {
  it("shows only the agent's service access", async () => {
    api.fetchAgent.mockResolvedValue(detail());
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AgentConnectorsView agentId="agent-1" />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId("service-access")).toBeTruthy();
    expect(screen.queryByText("General")).toBeNull();
  });
});
