import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setHostedEnabled } from "../../data/api";
import HostedSwitchDialog, { REASON_HINT } from "./HostedSwitchDialog";

function renderDialog(enabling: boolean, onConfirm = vi.fn(), error: string | null = null) {
  render(
    <HostedSwitchDialog
      open
      enabling={enabling}
      personName="Alex Example"
      busy={false}
      error={error}
      onCancel={() => {}}
      onConfirm={onConfirm}
    />,
  );
  return onConfirm;
}

describe("the admin's hosted agents switch (spec A2)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("turning off says what happens and what they'll see, and needs a reason", () => {
    const onConfirm = renderDialog(false);
    expect(screen.getByText("Turn off hosted agents for Alex Example?")).toBeTruthy();
    expect(screen.getByText("Turned off by your admin · Ask your admin to turn it on")).toBeTruthy();
    expect(
      screen.getByText(
        "Alex's agents in this workspace stop taking new work now, their AI access is cut off, and they stop within a minute. Any reply in progress is cut off. Nothing on the box is deleted.",
      ),
    ).toBeTruthy();
    expect(screen.getByPlaceholderText("Why are you turning this off?")).toBeTruthy();
    expect(screen.getByText(REASON_HINT)).toBeTruthy();
    const button = screen.getByRole("button", { name: "Turn off" }) as HTMLButtonElement;
    expect(button.className).toContain("MuiButton-containedError");
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } });
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  Left the team  " } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledWith("Left the team");
  });

  it("turning on needs a reason too", () => {
    const onConfirm = renderDialog(true);
    expect(screen.getByText("Turn on hosted agents for Alex Example?")).toBeTruthy();
    expect(
      screen.getByText(
        "Alex's agents in this workspace can start again. Their next message starts the box. If Alex's AI login was cleared when they were turned off, they'll be asked to set it up again.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Their usual states, or \u201cCan't reply right now · Check your AI login\u201d until the login is given.",
      ),
    ).toBeTruthy();
    expect(screen.getByPlaceholderText("Why are you turning this on?")).toBeTruthy();
    const button = screen.getByRole("button", { name: "Turn on" }) as HTMLButtonElement;
    // The main dark button, not the destructive red one (designer).
    expect(button.className).toContain("MuiButton-containedPrimary");
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Back from leave" } });
    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledWith("Back from leave");
  });

  it("shows the refusal it is given", () => {
    renderDialog(true, vi.fn(), "Only workspace admins can do this.");
    expect(screen.getByRole("alert").textContent).toBe(
      "Only workspace admins can do this.",
    );
  });

  it("sends the switch and the reason to the person's own route", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ enabled: false }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await setHostedEnabled("t/1", "u1", false, "Left the team")).toEqual({ enabled: false });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/gateway/tenants/t%2F1/hosted-people/u1");
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(JSON.stringify({ enabled: false, reason: "Left the team" }));
  });

  it("turns a refusal into a fixed message, never the server's own text", async () => {
    const MARKER = "zebra-marker-7f3c";
    for (const [status, fixed] of [
      [403, "Only workspace admins can do this."],
      [404, "This person isn't a member of this workspace."],
      [409, "Switch has paused this person. Their switch can change once Switch resumes them."],
      [422, "The reason wasn't accepted. Use up to 500 characters, with no names, messages or secrets."],
      [500, "That didn't go through. Reload the page and try again."],
    ] as const) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ detail: `no: ${MARKER}` }), { status })),
      );
      const failed = await setHostedEnabled("t1", "u1", true, "Back from leave").catch(
        (err: unknown) => err as Error,
      );
      expect((failed as Error).message).toBe(fixed);
      expect((failed as Error).message).not.toContain(MARKER);
    }
  });

  it("says the change failed when the server can't be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    await expect(setHostedEnabled("t1", "u1", true, "Back")).rejects.toThrow(
      "That didn't go through. Reload the page and try again.",
    );
  });
});
