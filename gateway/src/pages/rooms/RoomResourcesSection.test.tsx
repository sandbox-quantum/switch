import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as hooks from "../../data/hooks";
import RoomResourcesSection from "./RoomResourcesSection";

vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("../../data/hooks", () => ({
  useDocuments: vi.fn(),
  usePackages: vi.fn(),
  useReferences: vi.fn(),
  useRoomDocuments: vi.fn(),
  useRoomPackages: vi.fn(),
  useRoomReferences: vi.fn(),
}));

function returns<T>(data: T) {
  return { data, loading: false, error: null, refetch: vi.fn() };
}

const CONTROLS = [
  "Attach reference",
  "Detach Runbook",
  "Attach document",
  "Detach Spec",
  "Delete Notes",
  "Attach package",
  "Detach Starter kit",
];

describe("RoomResourcesSection", () => {
  beforeEach(() => {
    vi.mocked(hooks.useRoomReferences).mockReturnValue(
      returns([
        { id: "ref1", name: "Runbook", description: "", type: "confluence", type_display_name: "Confluence", packages: [] },
      ]) as never,
    );
    vi.mocked(hooks.useRoomDocuments).mockReturnValue(
      returns([
        { id: "d1", name: "Spec", description: "", scope: "global", packages: [] },
        { id: "d2", name: "Notes", description: "", scope: "room", created_by_agent_name: "planner" },
      ]) as never,
    );
    vi.mocked(hooks.useRoomPackages).mockReturnValue(
      returns([{ id: "p1", name: "Starter kit", description: "" }]) as never,
    );
    vi.mocked(hooks.useReferences).mockReturnValue(returns([]) as never);
    vi.mocked(hooks.useDocuments).mockReturnValue(returns([]) as never);
    vi.mocked(hooks.usePackages).mockReturnValue(returns([]) as never);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("offers attaching and detaching to someone who may write to the room", () => {
    render(<RoomResourcesSection roomId="r1" canWrite />);

    for (const name of CONTROLS) screen.getByRole("button", { name });
  });

  it("lists what is attached, with nothing to change, to a reader", () => {
    render(<RoomResourcesSection roomId="r1" canWrite={false} />);

    for (const item of ["Runbook", "Spec", "Notes", "Starter kit"]) screen.getByText(item);
    for (const name of CONTROLS) expect(screen.queryByRole("button", { name })).toBeNull();
  });
});
