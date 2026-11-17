import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudMachine, Controller, ManagedAgent } from "../../data/management";
import GetStartedPage from "./GetStartedPage";
import type { CloudSnapshot } from "./useCloudDevice";

vi.mock("../../data/AuthContext", () => ({
  useAuth: () => ({ user: { id: "me", name: "Ada Lovelace", email: "ada@example.com" } }),
}));

// The opening scene is Console's, tested there.
vi.mock("@switch-console/chat-ui/components/meet-buddy-intro", () => ({
  MeetBuddyIntro: ({ after }: { after: React.ReactNode }) => (
    <>
      <h1>Meet switch-buddy</h1>
      {after}
    </>
  ),
}));

const device = vi.hoisted(() => ({
  snapshot: null as CloudSnapshot | null,
  listeners: new Set<() => void>(),
  refresh: vi.fn(),
}));
vi.mock("./useCloudDevice", async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await importOriginal<typeof import("./useCloudDevice")>()),
    useCloudDevice: () => ({
      snapshot: useSyncExternalStore(
        (listener) => {
          device.listeners.add(listener);
          return () => device.listeners.delete(listener);
        },
        () => device.snapshot,
      ),
      error: null,
      refresh: device.refresh,
    }),
  };
});

function setDevice(snapshot: CloudSnapshot | null) {
  act(() => {
    device.snapshot = snapshot;
    for (const listener of device.listeners) listener();
  });
}

const onboarding = vi.hoisted(() => ({
  giveMachineLogin: vi.fn(),
  loginOutcome: vi.fn(),
  createBuddy: vi.fn(),
  welcomeChat: vi.fn(),
  startOver: vi.fn(),
}));
vi.mock("./onboarding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./onboarding")>()),
  ...onboarding,
}));

const api = vi.hoisted(() => ({ fetchAuthConfig: vi.fn() }));
vi.mock("../../data/api", () => api);

const management = vi.hoisted(() => ({ cloudMachineLifecycle: vi.fn() }));
vi.mock("../../data/management", () => management);

function machine(overrides: Partial<CloudMachine> = {}): CloudMachine {
  return {
    machine_id: "m1",
    state: "ready",
    desired_state: "running",
    stop_reason: null,
    stopped_by_admin: false,
    sleeping: false,
    revision: 1,
    error: null,
    error_code: null,
    retain_until: null,
    heartbeat_at: null,
    controller_id: "c1",
    ...overrides,
  };
}

function controller(auth: "ok" | "missing" | "expired", problem?: string): Controller {
  return {
    id: "c1",
    state: "online",
    status: {
      providers: [
        {
          provider: "claude",
          installed: true,
          auth,
          auth_source: auth === "missing" ? null : "sealed",
          auth_problem: problem,
        },
      ],
    },
    public_key: { alg: "x25519", key: "k", key_id: "id" },
  } as unknown as Controller;
}

function snapshot(overrides: Partial<CloudSnapshot> = {}): CloudSnapshot {
  return {
    available: true,
    machine: machine(),
    controller: controller("missing"),
    agents: [],
    ...overrides,
  };
}

const buddy = {
  agent_id: "a1",
  name: "switch-buddy-ada-lovelace",
  template: { id: "official:switch-buddy", key: "buddy" },
} as unknown as ManagedAgent;

function Where() {
  const location = useLocation();
  return <span data-testid="where">{location.pathname + location.search}</span>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/get-started"]}>
      <Routes>
        <Route path="/get-started" element={<GetStartedPage />} />
        <Route path="*" element={null} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
}

async function pickClaudeWithToken(token: string) {
  fireEvent.click(await screen.findByRole("button", { name: "Set up AI provider" }));
  fireEvent.click(screen.getByRole("button", { name: /Claude/ }));
  fireEvent.change(screen.getByPlaceholderText("Setup token"), { target: { value: token } });
  fireEvent.click(screen.getByRole("button", { name: "Start with Claude" }));
}

beforeEach(() => {
  device.snapshot = snapshot();
  onboarding.welcomeChat.mockResolvedValue("r1");
  api.fetchAuthConfig.mockResolvedValue({ test_account_reset_enabled: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("GetStartedPage", () => {
  it("meets switch-buddy first, and asks nothing about the device", async () => {
    device.snapshot = snapshot({ machine: machine({ state: "provisioning" }), controller: null });
    renderPage();
    expect(await screen.findByRole("button", { name: "Set up AI provider" })).toBeTruthy();
    expect(screen.queryByText(/device/i)).toBeNull();
  });

  it("holds the login until the device runs, then gives it and waits for it to sign in", async () => {
    device.snapshot = snapshot({ machine: machine({ state: "provisioning" }), controller: null });
    onboarding.giveMachineLogin.mockResolvedValue("op1");
    onboarding.loginOutcome.mockResolvedValue({ state: "succeeded" });
    onboarding.createBuddy.mockResolvedValue({ agentId: "a1", name: buddy.name });
    renderPage();
    await pickClaudeWithToken("sk-ant-oat");
    const stages = await screen.findByRole("status", { name: "Setting up switch-buddy…" });
    expect(stages.querySelector('[data-state="current"]')?.textContent).toBe(
      "Getting Switch Cloud ready",
    );
    expect(onboarding.giveMachineLogin).not.toHaveBeenCalled();

    setDevice(snapshot());
    await waitFor(() =>
      expect(onboarding.giveMachineLogin).toHaveBeenCalledWith(
        expect.objectContaining({ id: "c1" }),
        "claude",
        { kind: "setup-token", credential: "sk-ant-oat" },
      ),
    );
    expect(stages.querySelector('[data-state="current"]')?.textContent).toBe("Connecting Claude");

    setDevice(snapshot({ controller: controller("ok") }));
    await waitFor(() =>
      expect(onboarding.createBuddy).toHaveBeenCalledWith({
        controllerId: "c1",
        provider: "claude",
        person: { name: "Ada Lovelace", email: "ada@example.com" },
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe("/chats/agents/a1?chat=r1"),
    );
    expect(onboarding.welcomeChat).toHaveBeenCalledWith({
      agentId: "a1",
      agentName: buddy.name,
      firstName: "Ada",
    });
  });

  it("goes back to the providers with the device's reason when the login does not work", async () => {
    onboarding.giveMachineLogin.mockResolvedValue("op1");
    onboarding.loginOutcome.mockResolvedValue({
      state: "failed",
      message: "That token was refused.",
    });
    renderPage();
    await pickClaudeWithToken("bad");
    expect(await screen.findByText("That token was refused.", {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByText("Pick an AI provider to power switch-buddy:")).toBeTruthy();
    expect(onboarding.createBuddy).not.toHaveBeenCalled();
  });

  it("starts with the provider the device is already signed in to", async () => {
    device.snapshot = snapshot({ controller: controller("ok") });
    onboarding.createBuddy.mockResolvedValue({ agentId: "a1", name: buddy.name });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Signed in on Switch Cloud/ }));
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe("/chats/agents/a1?chat=r1"),
    );
    expect(onboarding.giveMachineLogin).not.toHaveBeenCalled();
  });

  it("opens the buddy the person already has", async () => {
    device.snapshot = snapshot({ agents: [buddy] });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Open switch-buddy" }));
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe("/chats/agents/a1?chat=r1"),
    );
  });

  it("gives Claude a Vertex AI login from a picked Google credential", async () => {
    onboarding.giveMachineLogin.mockResolvedValue("op1");
    onboarding.loginOutcome.mockResolvedValue({ state: "pending" });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Set up AI provider" }));
    fireEvent.click(screen.getByRole("button", { name: /Claude/ }));
    fireEvent.click(screen.getByRole("button", { name: "Vertex AI" }));
    fireEvent.change(screen.getByLabelText("Google Cloud project"), {
      target: { value: "my-project" },
    });
    const google = {
      type: "authorized_user",
      client_id: "a",
      client_secret: "b",
      refresh_token: "c",
    };
    fireEvent.change(screen.getByLabelText("Google credential file"), {
      target: {
        files: [new File([JSON.stringify(google)], "adc.json", { type: "application/json" })],
      },
    });
    await screen.findByText("adc.json");
    fireEvent.click(screen.getByRole("button", { name: "Start with Claude" }));
    await waitFor(() => expect(onboarding.giveMachineLogin).toHaveBeenCalled());
    const login = onboarding.giveMachineLogin.mock.calls[0]![2] as {
      kind: string;
      credential: string;
    };
    expect(login.kind).toBe("vertex");
    expect(JSON.parse(login.credential)).toEqual({
      v: 1,
      project: "my-project",
      region: "global",
      credentials: google,
    });
  });

  it("starts getting started over on a test server, once confirmed", async () => {
    api.fetchAuthConfig.mockResolvedValue({ test_account_reset_enabled: true });
    device.snapshot = snapshot({ agents: [buddy], controller: controller("ok") });
    onboarding.startOver.mockResolvedValue(undefined);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Start over" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, start over" }));
    await waitFor(() =>
      expect(onboarding.startOver).toHaveBeenCalledWith({
        buddyId: "a1",
        controller: expect.objectContaining({ id: "c1" }),
        machine: expect.objectContaining({ machine_id: "m1" }),
      }),
    );
    expect(device.refresh).toHaveBeenCalled();
  });

  it("offers no start over outside test servers", async () => {
    device.snapshot = snapshot({ agents: [buddy] });
    renderPage();
    await screen.findByRole("button", { name: "Open switch-buddy" });
    await waitFor(() => expect(api.fetchAuthConfig).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Start over" })).toBeNull();
  });

  it("says so where the workspace has no cloud devices", async () => {
    device.snapshot = snapshot({ available: false, machine: null, controller: null });
    renderPage();
    expect(await screen.findByText(/no cloud devices for this workspace/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByTestId("where").textContent).toBe("/");
  });
});
