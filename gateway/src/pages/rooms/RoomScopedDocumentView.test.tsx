import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoomDocumentDetail } from "../../data/api";
import * as api from "../../data/api";
import * as hooks from "../../data/hooks";
import RoomScopedDocumentView from "./RoomScopedDocumentView";

vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ roomId: "r1", documentId: "d1" }),
}));

vi.mock("../../data/hooks", () => ({
  useRoomDocument: vi.fn(),
}));

vi.mock("../../data/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../data/api")>();
  return { ...actual, detachDocumentFromRoom: vi.fn() };
});

function showDocument(canRemove: boolean, scope: "room" | "global" = "room") {
  vi.mocked(hooks.useRoomDocument).mockReturnValue({
    data: {
      id: "d1",
      name: "Notes",
      description: "",
      content: "hello",
      scope,
      can_remove: canRemove,
    } as RoomDocumentDetail,
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
}

describe("RoomScopedDocumentView", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("offers deleting a room document to someone who may delete it", () => {
    showDocument(true);
    render(<RoomScopedDocumentView />);

    screen.getByRole("button", { name: "Delete" });
  });

  it("shows a reader the document with no way to delete it", () => {
    showDocument(false);
    render(<RoomScopedDocumentView />);

    screen.getByText("hello");
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("offers unlinking, not deleting, a document only attached to the room", () => {
    showDocument(true, "global");
    render(<RoomScopedDocumentView />);

    screen.getByRole("button", { name: "Unlink from room" });
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("asks before deleting, and keeps asking with the server's reason when it fails", async () => {
    vi.mocked(api.detachDocumentFromRoom).mockRejectedValue(new Error("Not allowed"));
    showDocument(true);
    render(<RoomScopedDocumentView />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(api.detachDocumentFromRoom).not.toHaveBeenCalled();

    const dialog = await screen.findByRole("dialog", { name: "Delete Notes?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete document" }));

    await waitFor(() => expect(api.detachDocumentFromRoom).toHaveBeenCalledWith("r1", "d1"));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Not allowed");
  });
});
