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
      // Resume reads the audit log first (why they were paused): skip reads.
      const posts = fetchMock.mock.calls.filter(
        (call) => (call as unknown as [string, RequestInit?])[1]?.method === "POST",
      );
      expect(posts).toHaveLength(1);
      const [sent, init] = posts[0] as unknown as [string, RequestInit];
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

describe("Resume says why they were paused", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const pause = (reason: string) => ({
    id: "ev-9",
    occurred_at: "2026-11-05T10:00:00+00:00",
    actor_user_id: "op-1",
    actor_name: null,
    action: "hosted.user_paused",
    target_type: "user",
    target_id: USER,
    details: { phase: "requested", reason },
    title: null,
  });

  it("reads the newest pause for this person and shows its reason as text", async () => {
    const fetchMock = answer(200, [pause(`<img src=x onerror=alert(1)>Abuse report ${MARKER}`)]);
    vi.stubGlobal("fetch", fetchMock);
    renderRow(true, true);
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    const line = await screen.findByTestId("paused-because");
    await waitFor(() => expect(line.textContent).toContain("Abuse report"));
    expect(document.querySelector("img")).toBeNull();
    const [path] = fetchMock.mock.calls[0] as unknown as [string];
    expect(path).toContain("/gateway/shared-cloud/audit-events?");
    expect(path).toContain("action=hosted.user_paused");
    expect(path).toContain(`target_id=${USER}`);
  });

  it("says when no reason is recorded, or the log can't be read", async () => {
    vi.stubGlobal("fetch", answer(200, []));
    renderRow(true, true);
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() =>
      expect(screen.getByTestId("paused-because").textContent).toBe(
        "No reason is recorded. Switch may have paused them itself.",
      ),
    );
    cleanup();
    vi.stubGlobal("fetch", answer(500, {}));
    renderRow(true, true);
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() =>
      expect(screen.getByTestId("paused-because").textContent).toBe(
        "Couldn't read the audit log. Check it before resuming.",
      ),
    );
  });

  it("asks nothing for Pause or Restart", async () => {
    const fetchMock = answer(200, []);
    vi.stubGlobal("fetch", fetchMock);
    renderRow(false, true);
    fireEvent.click(screen.getByRole("button", { name: "Pause user" }));
    expect(screen.queryByTestId("paused-because")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the pause reason is capped", () => {
  it("shows at most 300 characters, with an ellipsis, never splitting a character", async () => {
    const { capped, REASON_SHOWN } = await import("./OperatorActionDialog");
    expect(REASON_SHOWN).toBe(300);
    expect(capped("short")).toBe("short");
    const long = "a".repeat(299) + "😀" + "b".repeat(50);
    const shown = capped(long);
    expect(Array.from(shown)).toHaveLength(301);
    expect(shown.endsWith("😀…")).toBe(true);
    expect(capped("x".repeat(300))).toBe("x".repeat(300));
  });
});
