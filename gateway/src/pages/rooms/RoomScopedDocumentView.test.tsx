import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentDetail, RoomDetail } from "../../data/api";
import * as hooks from "../../data/hooks";
import RoomScopedDocumentView from "./RoomScopedDocumentView";

// Deleting a room's document is a write to the room, offered only when the
// server says the caller may write to it. A reader sees the document only.

vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ roomId: "r1", documentId: "d1" }),
}));

vi.mock("../../data/hooks", () => ({
  useRoom: vi.fn(),
  useRoomDocument: vi.fn(),
}));

const doc = {
  id: "d1",
  name: "notes",
  description: "",
  instructions: "",
  content: "hello",
  scope: "room",
} as unknown as DocumentDetail;

const query = <T,>(data: T | null) => ({
  data,
  loading: false,
  error: null,
  refetch: vi.fn(),
});

function showDocument(room: { can_write: boolean } | null) {
  vi.mocked(hooks.useRoomDocument).mockReturnValue(query(doc));
  vi.mocked(hooks.useRoom).mockReturnValue(
    query(room && ({ id: "r1", ...room } as RoomDetail)),
  );
  render(<RoomScopedDocumentView />);
}

afterEach(cleanup);

describe("room document delete", () => {
  it("is not offered to someone who may only read the room", () => {
    showDocument({ can_write: false });

    expect(screen.getByText("hello")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("is not offered before the room has loaded", () => {
    showDocument(null);

    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("is offered to someone who may write to the room", () => {
    showDocument({ can_write: true });

    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  });
});
