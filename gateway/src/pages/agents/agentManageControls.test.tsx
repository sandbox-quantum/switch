import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDetail } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
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

function showPageAs(userId: string, canManage: boolean) {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: userId },
  } as unknown as ReturnType<typeof useAuth>);
  vi.mocked(hooks.useAgent).mockReturnValue({
    data: { ...agent, can_manage: canManage },
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
  it("are offered to someone else the server says may manage it, such as an admin", () => {
    showPageAs("u2", true);

    expect(screen.getByRole("button", { name: "Rename agent" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.queryByText(/can edit these options/)).toBeNull();
  });

  it("are offered to the owner", () => {
    showPageAs("u1", true);

    expect(screen.getByRole("button", { name: "Rename agent" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("are not offered to anyone else", () => {
    showPageAs("u2", false);

    expect(screen.queryByRole("button", { name: "Rename agent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(
      screen.getByText("Only the agent's owner and admins can edit these options."),
    ).toBeTruthy();
  });
});
