import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomDetail } from "../../data/api";
import * as hooks from "../../data/hooks";
import RoomScopedDocumentView from "./RoomScopedDocumentView";

vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ roomId: "r1", documentId: "d1" }),
}));

vi.mock("../../data/hooks", () => ({
  useRoom: vi.fn(),
  useRoomDocument: vi.fn(),
}));

function showRoom(canWrite: boolean) {
  vi.mocked(hooks.useRoom).mockReturnValue({
    data: { id: "r1", can_write: canWrite } as RoomDetail,
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
}

describe("RoomScopedDocumentView", () => {
  beforeEach(() => {
    vi.mocked(hooks.useRoomDocument).mockReturnValue({
      data: { id: "d1", name: "Notes", description: "", content: "hello", scope: "room" },
      loading: false,
      error: null,
      refetch: vi.fn(),
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("offers deleting the document to someone who may write to the room", () => {
    showRoom(true);
    render(<RoomScopedDocumentView />);

    screen.getByRole("button", { name: "Delete" });
  });

  it("says so when it cannot tell whether deleting is allowed", () => {
    vi.mocked(hooks.useRoom).mockReturnValue({
      data: null,
      loading: false,
      error: "HTTP 500",
      refetch: vi.fn(),
    });
    render(<RoomScopedDocumentView />);

    screen.getByText(/Couldn't load the room, so deleting is unavailable: HTTP 500/);
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("shows a reader the document with no way to delete it", () => {
    showRoom(false);
    render(<RoomScopedDocumentView />);

    screen.getByText("hello");
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });
});
