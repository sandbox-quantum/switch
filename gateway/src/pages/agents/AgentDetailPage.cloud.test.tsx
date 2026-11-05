import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDetail } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import * as hooks from "../../data/hooks";
import * as hostedCloud from "../../data/hostedCloud";
import AgentDetailPage from "./AgentDetailPage";

vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ agentId: "a1" }),
}));
vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));
vi.mock("../../data/hooks", () => ({
  useAgent: vi.fn(),
  useKnownAgentTypes: vi.fn(),
  useHostedV2: vi.fn(),
}));
vi.mock("../../data/hostedCloud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../data/hostedCloud")>();
  return { ...actual, useCloudView: vi.fn() };
});
vi.mock("./AddressingPolicySection", () => ({ default: () => null }));
vi.mock("./AgentManagementSection", () => ({ default: () => null }));
vi.mock("./ServiceAccessSection", () => ({ default: () => null }));
vi.mock("./cloud/CloudAgentControls", () => ({
  CloudAgentSection: ({ controllerId }: { controllerId: string }) => (
    <div>{`cloud controls on ${controllerId}`}</div>
  ),
  CloudRenameDialog: ({ open }: { open: boolean }) => (open ? <div>cloud rename</div> : null),
}));

const agent = {
  id: "a1",
  name: "site-builder",
  display_name: "Site builder",
  description: "",
  connector_type: "claude_code",
  connection_model: "auto_session",
  owner_id: "u1",
  owner_name: "ada",
  created_at: "2026-10-01T00:00:00Z",
  parent_agent_id: null,
  known_agent_type: null,
  known_agent_options: null,
  agent_type: "auto_session",
  integration_profile: {},
  tool_count: 0,
  model_count: 0,
  oauth_client_id: null,
  tools: [],
  models: [],
  rooms: [],
  sessions: [],
  children: [],
  addressing_policy: null,
  can_manage_agents: false,
} as AgentDetail;

function view(onBox: boolean) {
  return {
    machine: { controller_id: "c-box", agents: onBox ? ["a1"] : ["other"] },
    available: true,
    agents: new Map(),
    loaded: true,
    refresh: vi.fn(),
  } as unknown as hostedCloud.CloudView;
}

beforeEach(() => {
  vi.mocked(useAuth).mockReturnValue({ user: { id: "u1" } } as unknown as ReturnType<
    typeof useAuth
  >);
  vi.mocked(hooks.useAgent).mockReturnValue({
    data: agent,
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
  vi.mocked(hooks.useKnownAgentTypes).mockReturnValue({
    data: [],
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AgentDetailPage for an agent on the person's cloud box", () => {
  it("shows the cloud controls and the display-name rename with hosted agents v2 on", () => {
    vi.mocked(hooks.useHostedV2).mockReturnValue(true);
    vi.mocked(hostedCloud.useCloudView).mockReturnValue(view(true));
    render(<AgentDetailPage />);
    expect(screen.getByText("cloud controls on c-box")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rename agent" }));
    expect(screen.getByText("cloud rename")).toBeTruthy();
  });

  it("keeps today's page for an agent not on the box", () => {
    vi.mocked(hooks.useHostedV2).mockReturnValue(true);
    vi.mocked(hostedCloud.useCloudView).mockReturnValue(view(false));
    render(<AgentDetailPage />);
    expect(screen.queryByText(/cloud controls/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Rename agent" }));
    expect(screen.queryByText("cloud rename")).toBeNull();
    expect(screen.getByRole("textbox", { name: "New name" })).toBeTruthy();
  });

  it("asks for no box and shows nothing extra with hosted agents v2 off", () => {
    vi.mocked(hooks.useHostedV2).mockReturnValue(false);
    vi.mocked(hostedCloud.useCloudView).mockReturnValue(view(true));
    render(<AgentDetailPage />);
    expect(hostedCloud.useCloudView).toHaveBeenCalledWith(false);
    expect(screen.queryByText(/cloud controls/)).toBeNull();
  });

  it("shows no cloud controls to someone who doesn't own the agent", () => {
    vi.mocked(useAuth).mockReturnValue({ user: { id: "u2" } } as unknown as ReturnType<
      typeof useAuth
    >);
    vi.mocked(hooks.useHostedV2).mockReturnValue(true);
    vi.mocked(hostedCloud.useCloudView).mockReturnValue(view(true));
    render(<AgentDetailPage />);
    expect(screen.queryByText(/cloud controls/)).toBeNull();
  });
});
