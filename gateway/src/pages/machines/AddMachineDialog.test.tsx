import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AddMachineDialog from "./AddMachineDialog";

const REACHABLE = { supported: true, reason: null };

function issue(
  serverUrl: string | null,
  remoteDevices: { supported: boolean; reason: string | null } | "not sent" = REACHABLE,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: "swce_example",
            expires_at: "2026-10-03T13:10:00Z",
            server_url: serverUrl,
            // A server from before it sends no `remote_devices` at all.
            ...(remoteDevices === "not sent" ? {} : { remote_devices: remoteDevices }),
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
    expect(await screen.findAllByText(/--code swce_example/)).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Description (optional)"), {
      target: { value: "x".repeat(501) },
    });
    expect(screen.getByText("At most 500 characters.")).toBeTruthy();
    expect(screen.queryByText(/--code swce_example/)).toBeNull();
    expect(screen.getByText("swce_example")).toBeTruthy();
  });

  it("shows the warning and the enrollment code where Switch Console runs Switch", async () => {
    const reason =
      "This Switch is run by Switch Console, and only the computer it runs on can reach it, so other devices can't be added.";
    issue("http://localhost:8000", { supported: false, reason });
    render(<AddMachineDialog open onClose={() => {}} />);
    expect(await screen.findByText(reason)).toBeTruthy();
    expect(screen.getByText("swce_example")).toBeTruthy();
    expect(
      screen.getByText("switch-agent-controller enroll --server http://localhost:8000 --code swce_example"),
    ).toBeTruthy();
  });

  it("shows the warning and the enrollment code where the public address is a loopback one", async () => {
    const reason =
      "This Switch's public address is http://127.0.0.1:8000, which only the computer it runs on can reach. Set GATEWAY_PUBLIC_URL to an address other devices reach.";
    issue("http://127.0.0.1:8000", { supported: false, reason });
    render(<AddMachineDialog open onClose={() => {}} />);
    expect(await screen.findByText(reason)).toBeTruthy();
    expect(screen.getByText("swce_example")).toBeTruthy();
    expect(
      screen.getByText("switch-agent-controller enroll --server http://127.0.0.1:8000 --code swce_example"),
    ).toBeTruthy();
  });

  it("shows the warning and the enrollment code when Switch gives no reason", async () => {
    issue("https://switch-api.example.test", { supported: false, reason: null });
    render(<AddMachineDialog open onClose={() => {}} />);
    expect(await screen.findByText(/Other devices can't reach this Switch/)).toBeTruthy();
    expect(screen.getByText("swce_example")).toBeTruthy();
    expect(
      screen.getByText(
        "switch-agent-controller enroll --server https://switch-api.example.test --code swce_example",
      ),
    ).toBeTruthy();
  });

  it("shows the commands, as before, when a server from before remote_devices says nothing", async () => {
    issue("https://switch-api.example.test", "not sent");
    render(<AddMachineDialog open onClose={() => {}} />);
    expect(
      await screen.findByText(
        "switch-agent-controller enroll --server https://switch-api.example.test --code swce_example",
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText("Name (optional)")).toBeTruthy();
    expect(screen.queryByText(/Other devices can't reach this Switch/)).toBeNull();
  });

  it("says what to configure instead of showing a command that cannot work", async () => {
    issue(null);
    render(<AddMachineDialog open onClose={() => {}} />);
    expect(await screen.findByText("GATEWAY_PUBLIC_URL")).toBeTruthy();
    expect(screen.queryByText(/--server http/)).toBeNull();
    expect(screen.getByText("swce_example")).toBeTruthy();
  });
});
