import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AddMachineDialog from "./AddMachineDialog";

function issue(serverUrl: string | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: "swce_example",
            expires_at: "2026-10-03T13:10:00Z",
            server_url: serverUrl,
          }),
          { status: 201 },
        ),
    ),
  );
}

describe("AddMachineDialog", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("enrolls against the Switch API address the server gives, not this page's", async () => {
    issue("https://switch-api.example.test");
    render(<AddMachineDialog open onClose={() => {}} />);
    expect(
      await screen.findByText(
        "switch-agent-controller enroll --server https://switch-api.example.test --code swce_example",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(new RegExp(window.location.origin))).toBeNull();
  });

  it("says what to configure instead of showing a command that cannot work", async () => {
    issue(null);
    render(<AddMachineDialog open onClose={() => {}} />);
    expect(await screen.findByText("GATEWAY_PUBLIC_URL")).toBeTruthy();
    expect(screen.queryByText(/--server http/)).toBeNull();
    expect(screen.getByText("swce_example")).toBeTruthy();
  });
});
