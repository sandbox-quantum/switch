import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../data/api";
import * as hooks from "../../data/hooks";
import RoomCreateFormBody from "./RoomCreateFormBody";

vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));

vi.mock("../../data/AuthContext", () => ({
  useAuth: () => ({ canAdminTenant: false }),
}));

vi.mock("../../data/hooks", () => ({
  useAgents: vi.fn(),
  useBridges: vi.fn(),
  useBridgeUsers: vi.fn(),
  useRoomAgentCandidates: vi.fn(),
  useRoomGroups: vi.fn(),
}));

vi.mock("../../data/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../data/api")>();
  return { ...actual, createRoom: vi.fn() };
});

const bridge = {
  bridge_id: "b1",
  bridge_type: "slack",
  display_name: "Slack",
  status: "active",
  agent_greetings_enabled: false,
  channel_creation_supported: true,
  channel_creation_enabled: true,
  channel_ids_refused: null,
  room_count: 0,
  created_at: "2026-01-01T00:00:00Z",
  attention: null,
};

function data<T>(value: T) {
  return { data: value } as never;
}

beforeEach(() => {
  vi.mocked(hooks.useAgents).mockReturnValue(data([]));
  vi.mocked(hooks.useBridges).mockReturnValue(data([bridge]));
  vi.mocked(hooks.useBridgeUsers).mockReturnValue(data([]));
  vi.mocked(hooks.useRoomAgentCandidates).mockReturnValue(data({ agent_ids: [] }));
  vi.mocked(hooks.useRoomGroups).mockReturnValue(data([]));
  vi.mocked(api.createRoom).mockResolvedValue({ id: "r1" } as never);
  render(<RoomCreateFormBody />);
  fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "planning" } });
  fireEvent.change(screen.getByLabelText(/Description/), { target: { value: "d" } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function select(label: RegExp): HTMLElement {
  return screen.getByRole("combobox", { name: label });
}

async function choose(label: RegExp, option: string): Promise<void> {
  fireEvent.mouseDown(select(label));
  const listbox = await screen.findByRole("listbox");
  fireEvent.click(within(listbox).getByRole("option", { name: option }));
}

async function submit(): Promise<Record<string, unknown>> {
  fireEvent.click(screen.getByRole("button", { name: /Create/ }));
  await waitFor(() => expect(api.createRoom).toHaveBeenCalledTimes(1));
  return vi.mocked(api.createRoom).mock.calls[0][0] as unknown as Record<string, unknown>;
}

describe("RoomCreateFormBody access", () => {
  it("offers only Public and Private", async () => {
    fireEvent.mouseDown(select(/Access/));
    const options = within(await screen.findByRole("listbox")).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Public", "Private"]);
  });

  it("offers no access for a room on an app: its channel decides", async () => {
    await choose(/Bridge/, "Slack (slack)");
    await choose(/Channel type/, "Private channel");

    expect(screen.queryByRole("combobox", { name: /Access/ })).toBeNull();
    expect(await submit()).not.toHaveProperty("read_visibility");
  });

  it("drops a choice made before an app was picked", async () => {
    await choose(/Access/, "Private");
    await choose(/Bridge/, "Slack (slack)");

    expect(await submit()).not.toHaveProperty("read_visibility");
  });
});
