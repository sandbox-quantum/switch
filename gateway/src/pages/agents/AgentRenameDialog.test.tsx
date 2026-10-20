import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDetail, AgentSummary } from "../../data/api";
import * as api from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import * as hooks from "../../data/hooks";
import AgentDetailPage, { labelFromName } from "./AgentDetailPage";

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

vi.mock("../../data/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../data/api")>();
  return { ...actual, renameAgent: vi.fn() };
});

// The page's other sections fetch on their own; they are not under test here.
vi.mock("./AddressingPolicySection", () => ({ default: () => null }));
vi.mock("./AgentManagementSection", () => ({ default: () => null }));
vi.mock("./ServiceAccessSection", () => ({ default: () => null }));

describe("labelFromName", () => {
  it("writes a name out as a label", () => {
    expect(labelFromName("notes-helper")).toBe("Notes Helper");
    expect(labelFromName("release_captain.v2")).toBe("Release Captain V2");
  });

  it("ignores doubled separators", () => {
    expect(labelFromName("a--b")).toBe("A B");
  });
});

const agent: AgentDetail = {
  id: "a1",
  name: "notes-taker",
  display_name: "Notes Taker",
  description: "Takes notes",
  connector_type: "claude_code",
  connection_model: "auto_session",
  tool_count: 0,
  model_count: 0,
  owner_id: "u1",
  owner_name: "ada",
  oauth_client_id: null,
  created_at: "2026-10-01T00:00:00Z",
  parent_agent_id: null,
  known_agent_type: null,
  known_agent_options: null,
  agent_type: "auto_session",
  integration_profile: {},
  tools: [],
  models: [],
  rooms: [],
  sessions: [],
  children: [],
  addressing_policy: null,
  can_manage_agents: false,
};

function showPage(detail: AgentDetail) {
  vi.mocked(hooks.useAgent).mockReturnValue({
    data: detail,
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
  render(<AgentDetailPage />);
  fireEvent.click(screen.getByRole("button", { name: "Rename agent" }));
}

const nameField = () => screen.getByRole("textbox", { name: "New name" }) as HTMLInputElement;
const labelField = () =>
  screen.getByRole("textbox", { name: "Display name" }) as HTMLInputElement;

describe("RenameAgentDialog", () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { id: "u1" },
    } as unknown as ReturnType<typeof useAuth>);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("[]", { status: 200 })),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.mocked(api.renameAgent).mockReset();
  });

  it("suggests the new name written out while the label is the old name written out", () => {
    showPage(agent);
    expect(labelField().value).toBe("Notes Taker");

    fireEvent.change(nameField(), { target: { value: "meeting-scribe" } });

    expect(labelField().value).toBe("Meeting Scribe");
    expect(screen.getByText("Suggested from the new name. Change it if you like.")).toBeTruthy();
  });

  it("keeps a label that is not the name written out", () => {
    showPage({ ...agent, display_name: "Scribe" });

    fireEvent.change(nameField(), { target: { value: "meeting-scribe" } });

    expect(labelField().value).toBe("Scribe");
  });

  it("stops following the name once the label is edited", () => {
    showPage(agent);
    fireEvent.change(nameField(), { target: { value: "meeting-scribe" } });
    fireEvent.change(labelField(), { target: { value: "The Scribe" } });

    fireEvent.change(nameField(), { target: { value: "meeting-writer" } });

    expect(labelField().value).toBe("The Scribe");
  });

  it("sends the name and the display name together", async () => {
    vi.mocked(api.renameAgent).mockResolvedValue({
      agent: { ...agent, name: "meeting-scribe", display_name: "Meeting Scribe" } as AgentSummary,
      old_name: "notes-taker",
      bridge_failures: [],
      templates_mentioning_old_name: [],
    });
    showPage(agent);
    fireEvent.change(nameField(), { target: { value: "meeting-scribe" } });

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    await waitFor(() =>
      expect(api.renameAgent).toHaveBeenCalledWith("a1", "meeting-scribe", "Meeting Scribe"),
    );
    expect(
      await screen.findByText('Renamed "notes-taker" to "meeting-scribe", shown as "Meeting Scribe".'),
    ).toBeTruthy();
  });

  it("sends null for a cleared display name", async () => {
    vi.mocked(api.renameAgent).mockResolvedValue({
      agent: { ...agent, name: "meeting-scribe", display_name: null } as AgentSummary,
      old_name: "notes-taker",
      bridge_failures: [],
      templates_mentioning_old_name: [],
    });
    showPage(agent);
    fireEvent.change(nameField(), { target: { value: "meeting-scribe" } });
    fireEvent.change(labelField(), { target: { value: "  " } });

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    await waitFor(() =>
      expect(api.renameAgent).toHaveBeenCalledWith("a1", "meeting-scribe", null),
    );
  });

  it("says which platforms are behind after a rename", async () => {
    vi.mocked(api.renameAgent).mockResolvedValue({
      agent: { ...agent, name: "meeting-scribe" } as AgentSummary,
      old_name: "notes-taker",
      bridge_failures: ["slack: Slack is down"],
      templates_mentioning_old_name: [],
    });
    showPage(agent);
    fireEvent.change(nameField(), { target: { value: "meeting-scribe" } });

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    expect(await screen.findByText(/Not yet updated on: slack: Slack is down/)).toBeTruthy();
  });
});
