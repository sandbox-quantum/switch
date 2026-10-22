import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentDetail, RoomDetail } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import * as hooks from "../../data/hooks";
import RoomScopedDocumentView from "./RoomScopedDocumentView";

// Deleting a room's document is a write to the room: its owner, an admin, or
// anyone in a publicly writable room. A reader sees the document only.

vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ roomId: "r1", documentId: "d1" }),
}));

vi.mock("../../data/AuthContext", () => ({
  useAuth: vi.fn(),
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

function showDocument(room: Partial<RoomDetail> | null, canAdminTenant = false) {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: "u1" },
    canAdminTenant,
  } as unknown as ReturnType<typeof useAuth>);
  vi.mocked(hooks.useRoomDocument).mockReturnValue(query(doc));
  vi.mocked(hooks.useRoom).mockReturnValue(
    query(
      room && ({
        id: "r1",
        owner_id: "someone",
        read_visibility: "public",
        write_visibility: "private",
        ...room,
      } as RoomDetail),
    ),
  );
  render(<RoomScopedDocumentView />);
}

afterEach(cleanup);

describe("room document delete", () => {
  it("is not offered to a reader of the room", () => {
    showDocument({});

    expect(screen.getByText("hello")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("is not offered before the room has loaded", () => {
    showDocument(null);

    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("is offered to the room's owner", () => {
    showDocument({ owner_id: "u1" });

    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  });

  it("is offered in a publicly writable room", () => {
    showDocument({ write_visibility: "public" });

    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  });

  it("is offered to an admin", () => {
    showDocument({}, true);

    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  });
});
