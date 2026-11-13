import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSummary, BridgeDetail } from "../../data/api";
import * as hooks from "../../data/hooks";
import RoomCreateFormBody from "./RoomCreateFormBody";

// Create says why it is held, in the order the form asks for things, so
// nobody fills every starred field and is left with a greyed-out button.

vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../data/AuthContext", () => ({ useAuth: () => ({ canAdminTenant: false }) }));
vi.mock("../../data/hooks", () => ({
  useAgents: vi.fn(),
  useBridges: vi.fn(),
  useBridgeUsers: vi.fn(),
  useRoomGroups: vi.fn(),
  useRoomAgentCandidates: vi.fn(),
}));

const result = <T,>(data: T) => ({ data, loading: false, error: null, refetch: vi.fn() });

const agent = { id: "a1", name: "planner", connector_type: "claude-code", parent_agent_id: null } as AgentSummary;

const bridge = (overrides: Partial<BridgeDetail>) =>
  ({
    bridge_id: "b1",
    bridge_type: "slack",
    display_name: "Slack",
    channel_creation_supported: true,
    channel_creation_enabled: true,
    channel_ids_refused: null,
    ...overrides,
  }) as BridgeDetail;

function showForm(bridges: BridgeDetail[] = []) {
  vi.mocked(hooks.useBridges).mockReturnValue(result(bridges));
  render(<RoomCreateFormBody />);
}

const create = () => screen.getByRole<HTMLButtonElement>("button", { name: "Create" });
const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByRole("textbox", { name: label }), { target: { value } });

function chooseBridge(name: string) {
  fireEvent.mouseDown(screen.getByRole("combobox", { name: "Bridge (optional)" }));
  fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name }));
}

beforeEach(() => {
  vi.mocked(hooks.useAgents).mockReturnValue(result([agent]));
  vi.mocked(hooks.useBridgeUsers).mockReturnValue(result([]));
  vi.mocked(hooks.useRoomGroups).mockReturnValue(result([]));
  // The server's invite rule lets the viewer put the agent in a new room.
  vi.mocked(hooks.useRoomAgentCandidates).mockReturnValue(result({ agent_ids: [agent.id] }) as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("New room: why Create is disabled", () => {
  it("asks for a name and a description first", () => {
    showForm();
    expect(create().disabled).toBe(true);
    expect(screen.getByText("Give the room a name and a description.")).toBeTruthy();

    fill("Name", "planning");
    expect(screen.getByText("Give the room a description.")).toBeTruthy();
  });

  it("says a room with no bridge needs an agent, and marks Agents required", () => {
    showForm();
    fill("Name", "planning");
    fill("Description", "Sprint planning");

    expect(create().disabled).toBe(true);
    expect(
      screen.getByText("A room with no bridge needs at least one agent. Add one, or choose a bridge."),
    ).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Agents" }).hasAttribute("required")).toBe(true);
    expect(create().getAttribute("aria-describedby")).toBeTruthy();
  });

  it("lets a room with a bridge go without an agent", () => {
    showForm([bridge({})]);
    fill("Name", "planning");
    fill("Description", "Sprint planning");
    chooseBridge("Slack (slack)");

    expect(create().disabled).toBe(false);
    expect(screen.getByRole("combobox", { name: "Agents" }).hasAttribute("required")).toBe(false);
  });

  it("asks for the channel id when linking an existing channel", () => {
    showForm([bridge({ channel_creation_enabled: false })]);
    fill("Name", "planning");
    fill("Description", "Sprint planning");
    chooseBridge("Slack (slack)");

    expect(screen.getByText("Paste the external channel ID.")).toBeTruthy();
    fill("External channel ID", "C123");
    expect(create().disabled).toBe(false);
  });

  it("says when the bridge can neither make nor link a channel", () => {
    showForm([
      bridge({
        display_name: "Telegram",
        bridge_type: "telegram",
        channel_creation_supported: false,
        channel_ids_refused: "Add the bot to a Telegram group instead.",
      }),
    ]);
    fill("Name", "planning");
    fill("Description", "Sprint planning");
    chooseBridge("Telegram (telegram)");

    expect(screen.getByText("Telegram can't create a channel or link an existing one from here.")).toBeTruthy();
    expect(create().disabled).toBe(true);
  });
});
