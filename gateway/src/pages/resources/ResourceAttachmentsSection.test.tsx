import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomSummary } from "../../data/api";
import * as hooks from "../../data/hooks";
import { answerFetch } from "../../test/answerFetch";
import ResourceAttachmentsSection from "./ResourceAttachmentsSection";

vi.mock("../../data/hooks", () => ({ useRooms: vi.fn() }));

function returns<T>(data: T) {
  return { data, loading: false, error: null, refetch: vi.fn() };
}

function room(id: string, name: string, canWrite: boolean) {
  return { id, name, description: "", can_write: canWrite } as RoomSummary;
}

const ATTACHED = [
  { room_id: "r1", room_name: "planning", can_unlink: true },
  { room_id: "r2", room_name: "leadership", can_unlink: false },
];

const show = (props: { hiddenRoomsCount?: number; canAttach?: boolean } = {}) =>
  render(
    <ResourceAttachmentsSection
      kind="document"
      resourceId="d1"
      resourceLabel="Spec"
      hiddenRoomsCount={props.hiddenRoomsCount ?? 0}
      canAttach={props.canAttach ?? true}
    />,
  );

describe("ResourceAttachmentsSection", () => {
  beforeEach(() => {
    vi.mocked(hooks.useRooms).mockReturnValue(
      returns([
        room("r1", "planning", true),
        room("r2", "leadership", false),
        room("r3", "retro", true),
        room("r4", "announcements", false),
        room("r5", "design", true),
      ]),
    );
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("offers unlinking only from rooms the viewer takes part in", async () => {
    answerFetch({ "GET /documents/d1/rooms": [200, ATTACHED] });
    show();

    await screen.findByText("leadership");
    screen.getByRole("button", { name: "Unlink from planning" });
    expect(screen.queryByRole("button", { name: "Unlink from leadership" })).toBeNull();
  });

  it("asks before unlinking, and unlinks only once confirmed", async () => {
    const calls = answerFetch({
      "GET /documents/d1/rooms": [200, ATTACHED],
      "DELETE /rooms/r1/documents/d1": [200, {}],
    });
    show();

    fireEvent.click(await screen.findByRole("button", { name: "Unlink from planning" }));
    const dialog = await screen.findByRole("dialog", { name: "Unlink from planning" });
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Unlink" }));

    await vi.waitFor(() => expect(calls.some((call) => call.method === "DELETE")).toBe(true));
  });

  it("offers attaching only to rooms the viewer may write to, loading them on open", async () => {
    answerFetch({ "GET /documents/d1/rooms": [200, ATTACHED] });
    show();
    await screen.findByText("leadership");
    expect(hooks.useRooms).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Attach to room" }));

    await screen.findByText("retro");
    expect(screen.queryByText("announcements")).toBeNull();
    // Already attached, so not offered again.
    expect(screen.getAllByText("planning")).toHaveLength(1);
  });

  it("shows the rooms that took it when others refuse, and why the rest did not", async () => {
    answerFetch({
      "GET /documents/d1/rooms": [
        [200, ATTACHED],
        [200, [...ATTACHED, { room_id: "r3", room_name: "retro", can_unlink: true }]],
      ],
      "POST /rooms/r3/documents/d1": [200, {}],
      "POST /rooms/r5/documents/d1": [403, { detail: "You can't add to design." }],
    });
    show();

    fireEvent.click(await screen.findByRole("button", { name: "Attach to room" }));
    const picker = await screen.findByRole("dialog", { name: "Attach to rooms" });
    fireEvent.click(within(picker).getByText("retro"));
    fireEvent.click(within(picker).getByText("design"));
    fireEvent.click(within(picker).getByRole("button", { name: "Attach (2)" }));

    expect(await within(picker).findByText("Attached to 1 of 2 rooms. You can't add to design.")).toBeTruthy();
    // Behind the picker, which hides the page from the accessibility tree.
    expect(await screen.findByRole("button", { name: "Unlink from retro", hidden: true })).toBeTruthy();
    // What went in is no longer offered, nor sent again.
    expect(within(picker).getByRole("button", { name: "Attach (1)" })).toBeTruthy();
  });

  it("offers no attaching for a document that belongs to one room", async () => {
    answerFetch({ "GET /documents/d1/rooms": [200, ATTACHED] });
    show({ canAttach: false });

    await screen.findByText("leadership");
    expect(screen.queryByRole("button", { name: "Attach to room" })).toBeNull();
  });

  it("tells whoever manages it how many rooms it is in that they cannot open", async () => {
    answerFetch({ "GET /documents/d1/rooms": [200, ATTACHED] });
    show({ hiddenRoomsCount: 2 });

    await screen.findByText("Also in 2 private rooms you can't open.");
  });

  it("does not claim it is in no rooms when every room it is in is private", async () => {
    answerFetch({ "GET /documents/d1/rooms": [200, []] });
    show({ hiddenRoomsCount: 1 });

    await screen.findByText("In 1 private room you can't open.");
    expect(screen.queryByText("Not attached to any rooms yet.")).toBeNull();
  });

  it("says why the rooms could not be loaded", async () => {
    answerFetch({ "GET /documents/d1/rooms": [503, { detail: "The database is unavailable." }] });
    show();

    await screen.findByText("Couldn't load the rooms it is in: The database is unavailable.");
  });
});
