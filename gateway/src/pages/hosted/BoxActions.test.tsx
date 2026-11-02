import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import BoxActions from "./BoxActions";

const USER = "k1-6d2c91f03ab2";
const BOX = "k1-aaaabbbbcccc";
const MARKER = "zz-marker-7f3a";

function renderRow(paused: boolean, running: boolean, onDone = vi.fn()) {
  render(
    <BoxActions
      userKeyedId={USER}
      boxKeyedId={BOX}
      paused={paused}
      running={running}
      onDone={onDone}
    />,
  );
  return onDone;
}

function answer(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

async function confirmWith(button: string, confirm: string, reason: string) {
  fireEvent.click(screen.getByRole("button", { name: button }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: reason } });
  fireEvent.click(screen.getByRole("button", { name: confirm }));
}

describe("a Boxes row's operator actions (W6)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("offers Pause and Restart on a running box, Resume alone when paused", () => {
    renderRow(false, true);
    expect(screen.getByRole("button", { name: "Pause user" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restart box" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    cleanup();
    renderRow(true, false);
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pause user" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Restart box" })).toBeNull();
    cleanup();
    renderRow(false, false);
    expect(screen.queryByRole("button", { name: "Restart box" })).toBeNull();
  });

  it.each([
    ["Pause user", "Pause user", false, `/gateway/shared-cloud/users/${USER}/pause`],
    ["Resume", "Resume user", true, `/gateway/shared-cloud/users/${USER}/resume`],
    ["Restart box", "Restart box", false, `/gateway/shared-cloud/boxes/${BOX}/restart`],
  ])(
    "%s posts the reason in the body to its own route, then reloads",
    async (button, confirm, paused, url) => {
      const fetchMock = answer(200, { action_id: "a1" });
      vi.stubGlobal("fetch", fetchMock);
      const onDone = renderRow(paused, true);
      await confirmWith(button, confirm, `Ticket ${MARKER}`);
      await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
      const [sent, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(sent).toBe(url);
      expect(sent).not.toContain(MARKER);
      expect(init.method).toBe("POST");
      expect(init.credentials).toBe("include");
      expect(init.body).toBe(JSON.stringify({ reason: `Ticket ${MARKER}` }));
      expect(screen.queryByRole("dialog")).toBeNull();
    },
  );

  it("shows a fixed line on a refusal, never the server's text, and changes nothing", async () => {
    vi.stubGlobal("fetch", answer(409, { detail: `${MARKER} not ready` }));
    const onDone = renderRow(false, true);
    await confirmWith("Restart box", "Restart box", "Stuck");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "This box can't be restarted right now. Reload the list to see its current state.",
    );
    expect(document.body.textContent).not.toContain(MARKER);
    expect(onDone).not.toHaveBeenCalled();
    // The dialog stays open with the reason as typed, so it needn't be typed again.
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Stuck");
  });

  it("a non-operator's call is refused by the server and says so", async () => {
    vi.stubGlobal("fetch", answer(403, { detail: "Forbidden" }));
    renderRow(false, true);
    await confirmWith("Pause user", "Pause user", "Ticket 9");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Only Switch operators can do this.",
    );
  });

  it("forgets the reason when the dialog is cancelled", async () => {
    renderRow(false, true);
    fireEvent.click(screen.getByRole("button", { name: "Pause user" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: MARKER } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.innerHTML).not.toContain(MARKER);
    fireEvent.click(screen.getByRole("button", { name: "Pause user" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });
  it("never offers Restart without a box, even if marked running", () => {
    render(
      <BoxActions userKeyedId={USER} boxKeyedId={null} paused={false} running onDone={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Pause user" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restart box" })).toBeNull();
  });
});
