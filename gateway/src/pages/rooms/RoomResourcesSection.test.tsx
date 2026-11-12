import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../data/api";
import * as hooks from "../../data/hooks";
import RoomResourcesSection from "./RoomResourcesSection";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("react-router", () => ({
  useNavigate: () => navigate,
}));

vi.mock("../../data/hooks", () => ({
  useDocuments: vi.fn(),
  usePackages: vi.fn(),
  useReferences: vi.fn(),
  useRoomDocuments: vi.fn(),
  useRoomPackages: vi.fn(),
  useRoomReferences: vi.fn(),
}));

vi.mock("../../data/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../data/api")>();
  return { ...actual, detachDocumentFromRoom: vi.fn() };
});

function returns<T>(data: T) {
  return { data, loading: false, error: null, refetch: vi.fn() };
}

// The server says, per document, whether the viewer may remove it: unlink it
// if attached, delete it if room-scoped.
function roomDocuments({ canRemove }: { canRemove: boolean }) {
  vi.mocked(hooks.useRoomDocuments).mockReturnValue(
    returns([
      { id: "d1", name: "Spec", description: "", scope: "global", packages: [], can_remove: canRemove },
      { id: "d2", name: "Notes", description: "", scope: "room", created_by_agent_name: "planner", can_remove: canRemove },
    ]) as never,
  );
}

const ATTACH = ["Attach reference", "Attach document", "Attach package"];
const UNLINK = ["Detach Runbook", "Detach Starter kit"];
const REMOVE = ["Detach Spec", "Delete Notes"];

function button(name: string) {
  return screen.queryByRole("button", { name });
}

describe("RoomResourcesSection", () => {
  beforeEach(() => {
    vi.mocked(hooks.useRoomReferences).mockReturnValue(
      returns([
        { id: "ref1", name: "Runbook", description: "", type: "confluence", type_display_name: "Confluence", packages: [] },
      ]) as never,
    );
    roomDocuments({ canRemove: true });
    vi.mocked(hooks.useRoomPackages).mockReturnValue(
      returns([{ id: "p1", name: "Starter kit", description: "" }]) as never,
    );
    vi.mocked(hooks.useReferences).mockReturnValue(
      returns([
        { id: "ref2", name: "Playbook", description: "", type: "confluence", type_display_name: "Confluence" },
      ]) as never,
    );
    vi.mocked(hooks.useDocuments).mockReturnValue(returns([]) as never);
    vi.mocked(hooks.usePackages).mockReturnValue(returns([]) as never);
    vi.mocked(api.detachDocumentFromRoom).mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("offers attaching to writers and unlinking to those taking part", () => {
    render(<RoomResourcesSection roomId="r1" canWrite canUnlink />);

    for (const name of [...ATTACH, ...UNLINK, ...REMOVE]) screen.getByRole("button", { name });
  });

  it("lets someone taking part unlink without write access, but not attach", () => {
    render(<RoomResourcesSection roomId="r1" canWrite={false} canUnlink />);

    for (const name of [...UNLINK, ...REMOVE]) screen.getByRole("button", { name });
    for (const name of ATTACH) expect(button(name)).toBeNull();
  });

  it("follows the server on which documents the viewer may remove", () => {
    roomDocuments({ canRemove: false });
    render(<RoomResourcesSection roomId="r1" canWrite canUnlink />);

    for (const name of REMOVE) expect(button(name)).toBeNull();
    for (const name of UNLINK) screen.getByRole("button", { name });
  });

  it("lists what is attached, with nothing to change, to a reader", () => {
    roomDocuments({ canRemove: false });
    render(<RoomResourcesSection roomId="r1" canWrite={false} canUnlink={false} />);

    for (const item of ["Runbook", "Spec", "Notes", "Starter kit"]) screen.getByText(item);
    for (const name of [...ATTACH, ...UNLINK, ...REMOVE]) expect(button(name)).toBeNull();
  });

  it("loads what can be attached only when a picker opens", async () => {
    render(<RoomResourcesSection roomId="r1" canWrite canUnlink />);

    expect(hooks.useReferences).not.toHaveBeenCalled();
    expect(hooks.useDocuments).not.toHaveBeenCalled();
    expect(hooks.usePackages).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Attach reference" }));

    await screen.findByText("Playbook");
    expect(hooks.useReferences).toHaveBeenCalled();
    expect(hooks.useDocuments).not.toHaveBeenCalled();
  });

  it("opens an attached package only for a viewer who may read it", () => {
    // A private package its owner attached is listed to every reader of the
    // room, but the server says only some of them may open it.
    vi.mocked(hooks.useRoomPackages).mockReturnValue(
      returns([
        { id: "p1", name: "Starter kit", description: "", can_read: true },
        { id: "p2", name: "Secret kit", description: "", can_read: false },
      ]) as never,
    );
    render(<RoomResourcesSection roomId="r1" canWrite={false} canUnlink={false} />);

    fireEvent.click(screen.getByTestId("room-package-p1"));
    expect(navigate).toHaveBeenLastCalledWith("/resources/packages/p1");
    navigate.mockClear();
    fireEvent.click(screen.getByTestId("room-package-p2"));
    expect(navigate).not.toHaveBeenCalled();
    screen.getByText("Secret kit");
  });

  it("asks before deleting a room document, which cannot be undone", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<RoomResourcesSection roomId="r1" canWrite canUnlink />);

    fireEvent.click(screen.getByRole("button", { name: "Delete Notes" }));
    expect(confirm).toHaveBeenCalledWith(
      "Delete room document “Notes”? This cannot be undone.",
    );
    expect(api.detachDocumentFromRoom).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete Notes" }));
    await waitFor(() => expect(api.detachDocumentFromRoom).toHaveBeenCalledWith("r1", "d2"));
  });
});
