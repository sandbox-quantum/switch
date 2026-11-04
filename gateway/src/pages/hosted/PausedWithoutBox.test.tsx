import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PausedWithoutBox, { HEADING } from "./PausedWithoutBox";

const NO_BOX = "k1-6d2c91f03ab2aaaa";
const WITH_BOX = "k1-1111222233334444";
const ACTIVE = "k1-9999888877776666";

const PEOPLE = [
  { user_id: NO_BOX, paused: true },
  { user_id: WITH_BOX, paused: true },
  { user_id: ACTIVE, paused: false },
];
const BOXES = [{ user: WITH_BOX }];

describe("paused people with no box (W6)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists only a paused person with no box, with Resume and nothing else", () => {
    render(<PausedWithoutBox people={PEOPLE} boxes={BOXES} onDone={vi.fn()} />);
    expect(screen.getByRole("heading", { name: HEADING })).toBeTruthy();
    const rows = screen.getAllByTestId("paused-without-box");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("k1-6d2c 91f0 3ab2");
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pause user" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Restart box" })).toBeNull();
  });

  it("shows nothing when no paused person is without a box", () => {
    const { container } = render(
      <PausedWithoutBox people={PEOPLE.slice(1)} boxes={BOXES} onDone={vi.fn()} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("resumes that person through the shared dialog, then reloads", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ action_id: "a1" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onDone = vi.fn();
    render(<PausedWithoutBox people={PEOPLE} boxes={BOXES} onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(screen.getByRole("dialog").textContent).toContain("Resume user k1-6d2c 91f0 3ab2?");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Ticket 12" } });
    fireEvent.click(screen.getByRole("button", { name: "Resume user" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(`/gateway/shared-cloud/users/${NO_BOX}/resume`);
    expect(init.method).toBe("POST");
  });
});
