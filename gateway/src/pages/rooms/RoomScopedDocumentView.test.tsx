import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoomDocumentDetail } from "../../data/api";
import * as hooks from "../../data/hooks";
import RoomScopedDocumentView from "./RoomScopedDocumentView";

vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ roomId: "r1", documentId: "d1" }),
}));

vi.mock("../../data/hooks", () => ({
  useRoomDocument: vi.fn(),
}));

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
});
