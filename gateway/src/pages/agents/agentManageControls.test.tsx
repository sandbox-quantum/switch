import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDetail } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { ALL_OFF } from "../../data/featureFlags";
import * as hooks from "../../data/hooks";
import AgentDetailPage from "./AgentDetailPage";

// The server says whether the caller may manage the agent (its owner or an
// admin): those who may see the rename and options controls, anyone else sees
// neither.

vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ agentId: "a1" }),
}));

vi.mock("../../data/AuthContext", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../../data/hooks", () => ({
  useAgent: vi.fn(),
  useKnownAgentTypes: vi.fn(),
}));

// The page's other sections fetch on their own; they are not under test here.
vi.mock("./AddressingPolicySection", () => ({ default: () => null }));
vi.mock("./AgentManagementSection", () => ({ default: () => null }));
vi.mock("./ServiceAccessSection", () => ({ default: () => null }));

const agent = {
  id: "a1",
  name: "notes-taker",
  display_name: "Notes Taker",
  description: "",
  connector_type: "claude_code",
  connection_model: "auto_session",
  owner_id: "u1",
  owner_name: "ada",
  parent_agent_id: null,
  known_agent_type: "notes",
  known_agent_options: {},
  integration_profile: {},
  tools: [],
  models: [],
  rooms: [],
  sessions: [],
  children: [],
} as unknown as AgentDetail;

type AgentFlags = Pick<
  AgentDetail,
  "can_manage" | "can_rename" | "can_edit_options" | "can_transfer" | "transfer_blocked_reason"
>;

const MANAGER: AgentFlags = {
  can_manage: true,
  can_rename: true,
  can_edit_options: true,
  can_transfer: true,
  transfer_blocked_reason: null,
};
const OUTSIDER: AgentFlags = {
  can_manage: false,
  can_rename: false,
  can_edit_options: false,
  can_transfer: false,
  transfer_blocked_reason: null,
};

/** The page as the server describes the agent to this viewer. Who they are
 * does not matter to the page: every control follows these flags. */
function showPageWith(flags: AgentFlags) {
  vi.mocked(useAuth).mockReturnValue({
    capabilities: { features: ALL_OFF },
  } as unknown as ReturnType<typeof useAuth>);
  vi.mocked(hooks.useAgent).mockReturnValue({
    data: {
      ...agent,
      ...flags,
      can_change_manage_agents: false,
      can_grant_services: false,
    },
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
  vi.mocked(hooks.useKnownAgentTypes).mockReturnValue({
    data: [
      {
        key: "notes",
        connector_type: "claude_code",
        tool_count: 0,
        options_schema: { type: "object", properties: {} },
      },
    ],
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
  render(<AgentDetailPage />);
}

afterEach(cleanup);

describe("agent rename and options", () => {
  it("are offered to whoever the server says may manage it", () => {
    showPageWith(MANAGER);

    expect(screen.getByRole("button", { name: "Rename agent" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.queryByText(/can edit these options/)).toBeNull();
  });

  it("are not offered to anyone else", () => {
    showPageWith(OUTSIDER);

    expect(screen.queryByRole("button", { name: "Rename agent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(
      screen.getByText("Only the agent's owner and admins can edit these options."),
    ).toBeTruthy();
  });

  it("keeps rename from an agent the server will not rename, leaving its options", () => {
    showPageWith({ ...MANAGER, can_rename: false });

    expect(screen.queryByRole("button", { name: "Rename agent" })).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });
});

describe("agent options", () => {
  it("are not offered where the server will not edit them, though the agent is managed", () => {
    showPageWith({ ...MANAGER, can_edit_options: false });

    expect(screen.getByRole("button", { name: "Rename agent" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});

describe("agent transfer", () => {
  it("is offered where the server would move it", () => {
    showPageWith(MANAGER);

    const transfer = screen.getByRole("button", { name: "Transfer ownership" });
    expect((transfer as HTMLButtonElement).disabled).toBe(false);
  });

  it("is shown disabled, with the server's reason, where it would refuse", () => {
    showPageWith({
      ...MANAGER,
      can_transfer: false,
      transfer_blocked_reason: "Revoke its service grants before handing it over.",
    });

    const transfer = screen.getByRole("button", { name: "Transfer ownership" });
    expect((transfer as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Revoke its service grants before handing it over.")).toBeTruthy();
  });

  it("is not shown to someone who may not manage it", () => {
    showPageWith(OUTSIDER);

    expect(screen.queryByRole("button", { name: "Transfer ownership" })).toBeNull();
  });
});

describe("a read-only agent page", () => {
  it("says so at the top for someone who may not manage the agent", () => {
    showPageWith(OUTSIDER);

    expect(screen.getByRole("status").textContent).toContain(
      "only its owner and this workspace's admins can change it",
    );
  });

  it("says nothing of the kind to whoever may manage it", () => {
    showPageWith(MANAGER);

    expect(screen.queryByText(/only its owner and this workspace's admins/)).toBeNull();
  });
});
