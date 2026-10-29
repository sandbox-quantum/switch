import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomDetail } from "../../data/api";
import * as api from "../../data/api";
import { EditableFieldsSection } from "./RoomDetailPage";

// A publicly writable room lets anyone edit its settings, but the server only
// lets the owner or an admin change its access; a save carrying an access
// change from anyone else is refused whole.

vi.mock("../../data/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../data/api")>();
  return { ...actual, updateRoom: vi.fn() };
});

const room = {
  id: "r1",
  name: "lounge",
  description: "",
  instructions: "",
  read_visibility: "public",
  write_visibility: "public",
} as RoomDetail;

beforeEach(() => {
  vi.mocked(api.updateRoom).mockResolvedValue(room);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderSettings(canManage: boolean) {
  render(
    <EditableFieldsSection
      room={room}
      canWrite={true}
      canManage={canManage}
      onSaved={vi.fn()}
    />,
  );
}

describe("room settings", () => {
  it("let a writer edit settings but not change access", async () => {
    renderSettings(false);

    expect(
      screen.getByRole("combobox", { name: "Access" }).getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      screen.getByText(/Only the room's owner and admins can change who can see/),
    ).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "lobby" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.updateRoom).toHaveBeenCalledTimes(1));
    const body = vi.mocked(api.updateRoom).mock.calls[0][1];
    expect(body.name).toBe("lobby");
    expect(body).not.toHaveProperty("read_visibility");
    expect(body).not.toHaveProperty("write_visibility");
  });

  it("let the owner or an admin change access", () => {
    renderSettings(true);

    expect(
      screen.getByRole("combobox", { name: "Access" }).getAttribute("aria-disabled"),
    ).toBeNull();
  });
});
