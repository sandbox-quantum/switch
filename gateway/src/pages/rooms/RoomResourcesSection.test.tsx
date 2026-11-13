import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
const UNLINK = ["Unlink Runbook", "Unlink Starter kit"];
const REMOVE = ["Unlink Spec", "Delete Notes"];

function button(name: string) {
  return screen.queryByRole("button", { name });
}

describe("RoomResourcesSection", () => {
  beforeEach(() => {
    vi.mocked(hooks.useRoomReferences).mockReturnValue(
      returns([
        { id: "ref1", name: "Runbook", description: "", type: "confluence", type_display_name: "Confluence", packages: [], owner_id: "u-me" },
      ]) as never,
    );
    roomDocuments({ canRemove: true });
    vi.mocked(hooks.useRoomPackages).mockReturnValue(
      returns([{ id: "p1", name: "Starter kit", description: "", owner_id: "u-other" }]) as never,
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
    render(<RoomResourcesSection roomId="r1" viewerId={null} canAttach inRoom canUnlink />);

    for (const name of [...ATTACH, ...UNLINK, ...REMOVE]) screen.getByRole("button", { name });
  });

  it("lets someone taking part unlink without write access, but not attach", () => {
    render(<RoomResourcesSection roomId="r1" viewerId={null} canAttach={false} inRoom canUnlink />);

    for (const name of [...UNLINK, ...REMOVE]) screen.getByRole("button", { name });
    for (const name of ATTACH) expect(button(name)).toBeNull();
  });

  it("follows the server on which documents the viewer may remove", () => {
    roomDocuments({ canRemove: false });
    render(<RoomResourcesSection roomId="r1" viewerId={null} canAttach inRoom canUnlink />);

    for (const name of REMOVE) expect(button(name)).toBeNull();
    for (const name of UNLINK) screen.getByRole("button", { name });
  });

  it("lets someone in the room unlink what they own, and only that", () => {
    render(<RoomResourcesSection roomId="r1" viewerId="u-me" canAttach inRoom canUnlink={false} />);

    expect(button("Unlink Runbook")).not.toBeNull();
    expect(button("Unlink Starter kit")).toBeNull();
  });

  it("doesn't let someone outside the room unlink what they own", () => {
    render(<RoomResourcesSection roomId="r1" viewerId="u-me" canAttach={false} inRoom={false} canUnlink={false} />);

    expect(button("Unlink Runbook")).toBeNull();
  });

  it("lists what is attached, with nothing to change, to a reader", () => {
    roomDocuments({ canRemove: false });
    render(<RoomResourcesSection roomId="r1" viewerId={null} canAttach={false} inRoom canUnlink={false} />);

    for (const item of ["Runbook", "Spec", "Notes", "Starter kit"]) screen.getByText(item);
    for (const name of [...ATTACH, ...UNLINK, ...REMOVE]) expect(button(name)).toBeNull();
  });

  it("loads what can be attached only when a picker opens", async () => {
    render(<RoomResourcesSection roomId="r1" viewerId={null} canAttach inRoom canUnlink />);

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
    render(<RoomResourcesSection roomId="r1" viewerId={null} canAttach={false} inRoom canUnlink={false} />);

    fireEvent.click(screen.getByTestId("room-package-p1"));
    expect(navigate).toHaveBeenLastCalledWith("/resources/packages/p1");
    navigate.mockClear();
    fireEvent.click(screen.getByTestId("room-package-p2"));
    expect(navigate).not.toHaveBeenCalled();
    screen.getByText("Secret kit");
  });

  it("asks before deleting a room document, which cannot be undone", async () => {
    render(<RoomResourcesSection roomId="r1" viewerId={null} canAttach inRoom canUnlink />);

    fireEvent.click(screen.getByRole("button", { name: "Delete Notes" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Notes?" });
    expect(dialog.textContent).toContain("This cannot be undone.");
    expect(api.detachDocumentFromRoom).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete document" }));
    await waitFor(() => expect(api.detachDocumentFromRoom).toHaveBeenCalledWith("r1", "d2"));
  });
});
