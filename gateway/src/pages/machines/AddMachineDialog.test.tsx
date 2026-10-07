import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    expect(
      screen.getByText(
        /^curl -fsSL https:\/\/raw\.githubusercontent\.com\/.+\/install\.sh \| sh -s -- --server https:\/\/switch-api\.example\.test --code swce_example$/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(new RegExp(window.location.origin))).toBeNull();
  });

  it("puts the optional name and description into the command, quoted", async () => {
    issue("https://switch-api.example.test");
    render(<AddMachineDialog open onClose={() => {}} />);
    const base =
      "switch-agent-controller enroll --server https://switch-api.example.test --code swce_example";
    await screen.findByText(base);
    fireEvent.change(screen.getByLabelText("Name (optional)"), { target: { value: " build-box " } });
    fireEvent.change(screen.getByLabelText("Description (optional)"), {
      target: { value: "Bob's box in the office" },
    });
    expect(
      screen.getByText(`${base} --name build-box --description 'Bob'\\''s box in the office'`),
    ).toBeTruthy();
  });

  it("shows no command for a name or description that is too long", async () => {
    issue("https://switch-api.example.test");
    render(<AddMachineDialog open onClose={() => {}} />);
    await screen.findByText(/--code swce_example/);
    fireEvent.change(screen.getByLabelText("Description (optional)"), {
      target: { value: "x".repeat(501) },
    });
    expect(screen.getByText("At most 500 characters.")).toBeTruthy();
    expect(screen.queryByText(/--code swce_example/)).toBeNull();
    expect(screen.getByText("swce_example")).toBeTruthy();
  });

  it("says what to configure instead of showing a command that cannot work", async () => {
    issue(null);
    render(<AddMachineDialog open onClose={() => {}} />);
    expect(await screen.findByText("GATEWAY_PUBLIC_URL")).toBeTruthy();
    expect(screen.queryByText(/--server http/)).toBeNull();
    expect(screen.getByText("swce_example")).toBeTruthy();
  });
});
