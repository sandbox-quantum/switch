import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RoomLinkedRoomsSection from "./RoomLinkedRoomsSection";
import RoomResourcesSection from "./RoomResourcesSection";

// The room's linked rooms and resources change only for someone with write
// access to the room, so their controls show only to them. A linked room or
// package opens only for someone the server says may read it.

const navigate = vi.fn();
vi.mock("react-router", () => ({
  useNavigate: () => navigate,
}));

const result = <T,>(data: T) => ({
  data,
  loading: false,
  error: null,
  refetch: vi.fn(),
});

vi.mock("../../data/hooks", () => ({
  useLinkedRooms: () =>
    result([
      {
        target_room_id: "r2",
        target_room_name: "other",
        target_room_description: "",
        label: "see also",
        can_read: true,
      },
      {
        target_room_id: "r3",
        target_room_name: "hidden",
        target_room_description: "",
        label: "private",
        can_read: false,
      },
    ]),
  useRooms: () => result([]),
  useRoomReferences: () =>
    result([
      {
        id: "ref1",
        name: "spec",
        description: "",
        type: "url",
        type_display_name: "URL",
        packages: [],
      },
    ]),
  useReferences: () => result([]),
  useRoomDocuments: () =>
    result([
      { id: "doc1", name: "notes", description: "", scope: "global", packages: [] },
    ]),
  useDocuments: () => result([]),
  useRoomPackages: () =>
    result([
      {
        id: "pkg1",
        name: "kit",
        description: "",
        owner_id: "someone",
        read_visibility: "public",
        can_read: true,
      },
      {
        id: "pkg2",
        name: "secret-kit",
        description: "",
        owner_id: "someone",
        read_visibility: "private",
        can_read: false,
      },
      {
        id: "pkg3",
        name: "my-kit",
        description: "",
        owner_id: "u1",
        read_visibility: "private",
        can_read: true,
      },
    ]),
  usePackages: () => result([]),
}));

afterEach(() => {
  cleanup();
  navigate.mockReset();
});

function renderSections(canWrite: boolean) {
  render(
    <>
      <RoomResourcesSection roomId="r1" canWrite={canWrite} />
      <RoomLinkedRoomsSection roomId="r1" canWrite={canWrite} />
    </>,
  );
}

const ADD_BUTTONS = [
  "Attach reference",
  "Attach document",
  "Attach package",
  "Add linked room",
];

describe("room resources and linked rooms", () => {
  it("offer no attach, detach or link controls without write access", () => {
    renderSections(false);

    expect(screen.getByText("spec")).toBeTruthy();
    expect(screen.getByText("other")).toBeTruthy();
    for (const name of ADD_BUTTONS) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.queryByTestId("DeleteOutlineIcon")).toBeNull();
  });

  it("offer them with write access", () => {
    renderSections(true);

    for (const name of ADD_BUTTONS) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    // A reference, a document, three packages and two linked rooms.
    expect(screen.getAllByTestId("DeleteOutlineIcon")).toHaveLength(7);
  });
});

describe("linked rooms and attached packages", () => {
  it("open only when the viewer may read them", () => {
    renderSections(false);

    fireEvent.click(screen.getByTestId("linked-room-r2"));
    expect(navigate).toHaveBeenLastCalledWith("/rooms/r2");
    fireEvent.click(screen.getByTestId("room-package-pkg1"));
    expect(navigate).toHaveBeenLastCalledWith("/resources/packages/pkg1");
    fireEvent.click(screen.getByTestId("room-package-pkg3"));
    expect(navigate).toHaveBeenLastCalledWith("/resources/packages/pkg3");
    navigate.mockReset();

    fireEvent.click(screen.getByTestId("linked-room-r3"));
    fireEvent.click(screen.getByTestId("room-package-pkg2"));
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByText("hidden")).toBeTruthy();
    expect(screen.getByText("secret-kit")).toBeTruthy();
  });

});
