import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudMachine, Controller, ManagedAgent } from "../../data/management";
import { GET_SWITCH_CONSOLE_URL } from "../templates/OpenInConsoleDialog";
import GetStartedPage from "./GetStartedPage";
import type { CloudSnapshot } from "./useCloudDevice";

const auth = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("../../data/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "me", name: "Ada Lovelace", email: "ada@example.com" },
    session: { tenant: { id: "t1" } },
    refresh: auth.refresh,
  }),
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

const management = vi.hoisted(() => ({
  fetchControllers: vi.fn(),
  cloudMachineLifecycle: vi.fn(),
  fetchProviders: vi.fn(),
  startBrowserSignIn: vi.fn(),
  browserSignIn: vi.fn(),
  sendSignInCode: vi.fn(),
}));

/** What the server lists by default, in its order. */
const SERVER_PROVIDERS = [
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["opencode", "OpenCode"],
  ["antigravity", "Antigravity"],
  ["cursor", "Cursor CLI"],
].map(([id, label]) => ({ id, label, advanced_fields: [] }));
vi.mock("../../data/management", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../data/management")>()),
  ...management,
}));

function setDevice(snapshot: CloudSnapshot | null) {
  act(() => {
    device.snapshot = snapshot;
    for (const listener of device.listeners) listener();
  });
}

function setControllers(controllers: Controller[]) {
  management.fetchControllers.mockResolvedValue(controllers);
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


function machine(overrides: Partial<CloudMachine> = {}): CloudMachine {
  return {
    machine_id: "m1",
    state: "ready",
    desired_state: "running",
    stop_reason: null,
    stopped_by_admin: false,
    sleeping: false,
    revision: 1,
    instance_type: null,
    error: null,
    error_code: null,
    retain_until: null,
    heartbeat_at: null,
    disk: null,
    memory: null,
    agents: [],
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

/** A device that reports `installed` installed, none signed in. */
function reporting(installed: string[]): Controller {
  const reported = controller("missing");
  return {
    ...reported,
    status: {
      providers: installed.map((provider) => ({
        provider,
        installed: true,
        auth: "missing",
        auth_source: null,
      })),
    },
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
  fireEvent.click(screen.getByRole("button", { name: /Claude/, pressed: false }));
  fireEvent.change(screen.getByPlaceholderText("Setup token"), { target: { value: token } });
  fireEvent.click(screen.getByRole("button", { name: "Start with Claude Code" }));
}

beforeEach(() => {
  device.snapshot = snapshot();
  management.fetchControllers.mockResolvedValue([]);
  management.fetchProviders.mockResolvedValue(SERVER_PROVIDERS);
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
    expect(stages.querySelector('[data-state="current"]')?.textContent).toBe("Connecting Claude Code");

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

  it("offers no browser sign-in on Switch Cloud, whose controller has none", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Set up AI provider" }));
    fireEvent.click(screen.getByRole("button", { name: /Claude/, pressed: false }));
    expect(screen.queryByLabelText("Sign in with browser")).toBeNull();
    expect(screen.getByPlaceholderText("Setup token")).toBeTruthy();
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
    expect(screen.getByText(/Pick an AI provider to power switch-buddy/)).toBeTruthy();
    expect(onboarding.createBuddy).not.toHaveBeenCalled();
  });

  it("shows why the server refuses to start a stopped device, and asks again on Try again", async () => {
    device.snapshot = snapshot({
      machine: machine({ state: "stopped", desired_state: "stopped", stop_reason: "owner" }),
      controller: null,
    });
    management.cloudMachineLifecycle.mockRejectedValue(
      new Error("This server does not support cloud agents."),
    );
    renderPage();
    await pickClaudeWithToken("sk-ant-oat");
    expect(
      await screen.findByText("This server does not support cloud agents."),
    ).toBeTruthy();
    expect(management.cloudMachineLifecycle).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(management.cloudMachineLifecycle).toHaveBeenCalledTimes(2));
    expect(management.cloudMachineLifecycle).toHaveBeenLastCalledWith("m1", "start", 1);
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
    fireEvent.click(screen.getByRole("button", { name: /Claude/, pressed: false }));
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
    fireEvent.click(screen.getByRole("button", { name: "Start with Claude Code" }));
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

  it("gives Codex the sign-in file picked from a ChatGPT sign-in, refusing one that is not", async () => {
    onboarding.giveMachineLogin.mockResolvedValue("op1");
    onboarding.loginOutcome.mockResolvedValue({ state: "pending" });
    device.snapshot = snapshot({ controller: reporting(["claude", "codex"]) });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Set up AI provider" }));
    fireEvent.click(screen.getByRole("button", { name: /Codex/, pressed: false }));
    fireEvent.click(screen.getByRole("button", { name: "Sign-in file" }));
    const pick = (text: string, name: string) =>
      fireEvent.change(screen.getByLabelText("Codex sign-in file"), {
        target: { files: [new File([text], name, { type: "application/json" })] },
      });

    pick("[]", "list.json");
    await screen.findByText("list.json");
    fireEvent.click(screen.getByRole("button", { name: "Start with Codex" }));
    expect(await screen.findByText(/not a sign-in file/)).toBeTruthy();
    expect(onboarding.giveMachineLogin).not.toHaveBeenCalled();

    const auth = '{"auth_mode":"chatgpt","tokens":{"refresh_token":"placeholder"}}';
    pick(auth, "auth.json");
    await screen.findByText("auth.json");
    fireEvent.click(screen.getByRole("button", { name: "Start with Codex" }));
    await waitFor(() =>
      expect(onboarding.giveMachineLogin).toHaveBeenCalledWith(
        expect.objectContaining({ id: "c1" }),
        "codex",
        { kind: "auth-json", credential: auth },
      ),
    );
  });

  it("shows every provider Switch runs, those the device can't run disabled with why", async () => {
    device.snapshot = snapshot({ machine: machine({ state: "provisioning" }), controller: null });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Set up AI provider" }));
    const card = (name: RegExp) =>
      screen.getByRole("button", { name, pressed: false }) as HTMLButtonElement;
    await screen.findByRole("button", { name: /Antigravity/, pressed: false });
    // Before the device reports: what every cloud device installs can be picked.
    expect(card(/Claude Code/).disabled).toBe(false);
    expect(card(/Codex/).disabled).toBe(false);
    for (const name of [/OpenCode/, /Antigravity/, /Cursor CLI/]) {
      expect(card(name).disabled).toBe(true);
      expect(card(name).textContent).toMatch(/Checking Switch Cloud/);
    }

    setDevice(
      snapshot({
        controller: {
          ...reporting(["claude", "opencode", "antigravity"]),
          status: {
            providers: [
              ...reporting(["claude", "opencode", "antigravity"]).status!.providers,
              { provider: "codex", installed: false, auth: "missing", auth_source: null },
            ],
          },
        } as unknown as Controller,
      }),
    );
    await waitFor(() => expect(card(/Codex/).textContent).toMatch(/Not installed on Switch Cloud/));
    expect(card(/Codex/).disabled).toBe(true);
    // Not checked yet: it waits for the device's check rather than being left out.
    expect(card(/Cursor CLI/).textContent).toMatch(/Checking Switch Cloud/);
    expect(card(/Cursor CLI/).disabled).toBe(true);
    expect(card(/OpenCode/).disabled).toBe(false);
    expect(card(/Antigravity/).disabled).toBe(false);
  });

  it("says a provider the device left out of its settled report is not available, not checking", async () => {
    const reported = (observedAt: string) =>
      ({
        ...reporting(["claude", "codex", "antigravity", "cursor"]),
        connection: { connected_at: "2026-11-26T10:00:00Z", disconnected_at: null, disconnect_reason: null },
        status: {
          ...reporting(["claude", "codex", "antigravity", "cursor"]).status!,
          observed_at: observedAt,
        },
      }) as unknown as Controller;
    device.snapshot = snapshot({ controller: reported("2026-11-26T10:00:20Z") });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Set up AI provider" }));
    const openCode = () => screen.getByRole("button", { name: /OpenCode/, pressed: false }) as HTMLButtonElement;
    expect(openCode().textContent).toMatch(/Checking Switch Cloud/);

    setDevice(snapshot({ controller: reported("2026-11-26T10:02:00Z") }));
    await waitFor(() => expect(openCode().textContent).toMatch(/Not available on Switch Cloud/));
    expect(openCode().disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Sign in to OpenCode" })).toBeNull();
  });

  it("leaves a picked provider alone above its login, with the login's first field focused", async () => {
    device.snapshot = snapshot({ controller: reporting(["claude", "codex"]) });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Set up AI provider" }));
    expect(
      screen.getByText("Your Switch Cloud starts with no AI logins. Pick an AI provider to power switch-buddy and sign in to it:"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Claude Code" }));

    expect(document.activeElement).toBe(screen.getByPlaceholderText("Setup token"));
    expect(screen.getByText(/claude setup-token/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Codex/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Choose another provider" }));
    expect(screen.getByRole("button", { name: /Codex/, pressed: false })).toBeTruthy();
    expect(screen.queryByPlaceholderText("Setup token")).toBeNull();
  });

  it("says switch-buddy runs on Switch Cloud, and where to get Switch Console to run agents locally", async () => {
    renderPage();
    await screen.findByRole("button", { name: "Set up AI provider" });
    expect(screen.getByText(/switch-buddy runs on your Switch Cloud\. To run agents on your own computer/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Switch Console" }).getAttribute("href")).toBe(
      GET_SWITCH_CONSOLE_URL,
    );
  });

  it("puts a Sign in button in each card that needs a login, and it opens that login", async () => {
    device.snapshot = snapshot({
      controller: {
        ...controller("ok"),
        status: {
          providers: [
            ...controller("ok").status!.providers,
            ...reporting(["codex", "antigravity"]).status!.providers,
            { provider: "opencode", installed: false, auth: "missing", auth_source: null },
          ],
        },
      } as unknown as Controller,
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "use other providers" }));
    await screen.findByRole("button", { name: /^Antigravity/, pressed: false });
    expect(screen.queryByRole("button", { name: "Sign in to Claude Code" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in to OpenCode" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in to Codex" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Sign in to Antigravity" }));
    expect(screen.getByRole("button", { name: /^Antigravity/, pressed: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start with Antigravity" })).toBeTruthy();
  });

  it("gives OpenCode its sign-in file, and offers Antigravity a sign-in file or Vertex AI", async () => {
    onboarding.giveMachineLogin.mockResolvedValue("op1");
    onboarding.loginOutcome.mockResolvedValue({ state: "pending" });
    device.snapshot = snapshot({ controller: reporting(["opencode", "antigravity"]) });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Set up AI provider" }));
    fireEvent.click(await screen.findByRole("button", { name: /Antigravity/, pressed: false }));
    expect(screen.getByRole("button", { name: "Sign-in file" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Vertex AI" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Choose another provider" }));
    fireEvent.click(screen.getByRole("button", { name: /OpenCode/, pressed: false }));
    expect(screen.getByText(/opencode\/auth\.json/)).toBeTruthy();
    const auth = '{"opencode":{"type":"api","key":"placeholder"}}';
    fireEvent.change(screen.getByLabelText("OpenCode sign-in file"), {
      target: { files: [new File([auth], "auth.json", { type: "application/json" })] },
    });
    await screen.findByText("auth.json");
    fireEvent.click(screen.getByRole("button", { name: "Start with OpenCode" }));
    await waitFor(() =>
      expect(onboarding.giveMachineLogin).toHaveBeenCalledWith(
        expect.objectContaining({ id: "c1" }),
        "opencode",
        { kind: "auth-json", credential: auth },
      ),
    );
  });

  it("skips to AI providers, from meeting switch-buddy and from picking a provider", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Skip" }));
    expect(screen.getByTestId("where").textContent).toBe("/settings/ai-providers");
    cleanup();

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Set up AI provider" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(screen.getByTestId("where").textContent).toBe("/settings/ai-providers");
  });

  it("starts getting started over on a test server, once confirmed, and signs out", async () => {
    api.fetchAuthConfig.mockResolvedValue({ test_account_reset_enabled: true });
    const ctrl = controller("ok");
    device.snapshot = snapshot({ agents: [buddy], controller: ctrl });
    onboarding.startOver.mockResolvedValue(undefined);
    localStorage.setItem("switch.get-started.sent:me:t1", "2026-01-01");
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Start over" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, start over" }));
    await waitFor(() =>
      expect(onboarding.startOver).toHaveBeenCalledWith({
        buddyId: buddy.agent_id,
        controller: ctrl,
        email: "ada@example.com",
      }),
    );
    // Signed out by the server; the session is read again to show it.
    await waitFor(() => expect(auth.refresh).toHaveBeenCalled());
    // The next sign-in opens Get started again, as a first visit does.
    expect(localStorage.getItem("switch.get-started.sent:me:t1")).toBeNull();
  });

  it("offers no start over outside test servers", async () => {
    device.snapshot = snapshot({ agents: [buddy] });
    renderPage();
    await screen.findByRole("button", { name: "Open switch-buddy" });
    await waitFor(() => expect(api.fetchAuthConfig).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Start over" })).toBeNull();
  });

  it("offers adding a device when cloud unavailable and no local devices", async () => {
    device.snapshot = snapshot({ available: false, machine: null, controller: null });
    renderPage();
    expect(await screen.findByText(/needs a device to run on/, {}, { timeout: 6000 })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a device" })).toBeTruthy();
  });

  it("moves on when a device appears after adding one", async () => {
    device.snapshot = snapshot({ available: false, machine: null, controller: null });
    onboarding.createBuddy.mockResolvedValue({ agentId: "a1", name: buddy.name });
    renderPage();
    expect(await screen.findByText(/needs a device to run on/, {}, { timeout: 6000 })).toBeTruthy();

    const localController = controller("ok");
    setControllers([localController]);

    await waitFor(
      () => {
        expect(screen.queryByText(/needs a device to run on/)).toBeNull();
      },
      { timeout: 6000 }
    );
    expect(screen.getByRole("button", { name: /Signed in on/ })).toBeTruthy();
  }, 15000);

  it("uses local device when cloud unavailable and device is online", async () => {
    device.snapshot = snapshot({ available: false, machine: null, controller: null });
    const localController = controller("ok");
    setControllers([localController]);
    onboarding.createBuddy.mockResolvedValue({ agentId: "a1", name: buddy.name });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /Signed in on/ }, { timeout: 6000 }));

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
  });

  it("shows device name in provider choice when using local device", async () => {
    device.snapshot = snapshot({ available: false, machine: null, controller: null });
    const localController = { ...controller("ok"), name: "My Laptop" };
    setControllers([localController]);
    renderPage();

    expect(await screen.findByText(/Signed in on My Laptop/, {}, { timeout: 6000 })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Switch Console" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "use other providers" }));
    expect(screen.getByText("Pick an AI provider to power switch-buddy:")).toBeTruthy();
  });

  it("shows device selector when multiple local devices available", async () => {
    device.snapshot = snapshot({ available: false, machine: null, controller: null });
    const c1 = { ...controller("ok"), id: "c1", name: "Device 1" };
    const c2 = { ...controller("missing"), id: "c2", name: "Device 2" };
    setControllers([c1, c2]);
    renderPage();

    expect(await screen.findByText("Device:", {}, { timeout: 6000 })).toBeTruthy();
    const select = screen.getByRole("combobox", { name: "Device" });
    expect(select.querySelector("[data-slot=select-value]")?.textContent).toBe("Device 1");
  }, 10000);

  it("picks the second device and uses it for createBuddy", async () => {
    const user = userEvent.setup();
    device.snapshot = snapshot({ available: false, machine: null, controller: null });
    const c1 = { ...controller("missing"), id: "c1", name: "Device 1" };
    const c2 = { ...controller("missing"), id: "c2", name: "Device 2" };
    setControllers([c1, c2]);
    onboarding.giveMachineLogin.mockResolvedValue("op1");
    onboarding.loginOutcome.mockResolvedValue({ state: "succeeded" });
    onboarding.createBuddy.mockResolvedValue({ agentId: "a1", name: buddy.name });
    renderPage();

    expect(await screen.findByText("Device:", {}, { timeout: 6000 })).toBeTruthy();
    const deviceSelect = screen.getByRole("combobox", { name: "Device" });

    await user.click(deviceSelect);
    const option2 = await screen.findByRole("option", { name: "Device 2" });
    await user.click(option2);
    await waitFor(() =>
      expect(deviceSelect.querySelector("[data-slot=select-value]")?.textContent).toBe("Device 2"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Set up AI provider" }));
    fireEvent.click(screen.getByRole("button", { name: /Claude/, pressed: false }));
    fireEvent.click(screen.getByLabelText("Setup token"));
    fireEvent.change(screen.getByPlaceholderText("Setup token"), { target: { value: "sk-ant-oat" } });
    fireEvent.click(screen.getByRole("button", { name: "Start with Claude Code" }));

    await waitFor(() =>
      expect(onboarding.giveMachineLogin).toHaveBeenCalledWith(
        expect.objectContaining({ id: "c2" }),
        "claude",
        { kind: "setup-token", credential: "sk-ant-oat" },
      ),
    );

    const signedInC2 = { ...c2, status: { providers: [{ provider: "claude", installed: true, auth: "ok", auth_source: "sealed" }] } } as Controller;
    setControllers([c1, signedInC2]);

    await waitFor(
      () =>
        expect(onboarding.createBuddy).toHaveBeenCalledWith({
          controllerId: "c2",
          provider: "claude",
          person: { name: "Ada Lovelace", email: "ada@example.com" },
        }),
      { timeout: 6000 }
    );
  }, 15000);

  it("gives provider login to local device when using local path", async () => {
    device.snapshot = snapshot({ available: false, machine: null, controller: null });
    const localController = controller("missing");
    setControllers([localController]);
    onboarding.giveMachineLogin.mockResolvedValue("op1");
    onboarding.loginOutcome.mockResolvedValue({ state: "succeeded" });
    onboarding.createBuddy.mockResolvedValue({ agentId: "a1", name: buddy.name });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Set up AI provider" }, { timeout: 6000 }));
    fireEvent.click(screen.getByRole("button", { name: /Claude/, pressed: false }));
    fireEvent.click(screen.getByLabelText("Setup token"));
    fireEvent.change(screen.getByPlaceholderText("Setup token"), { target: { value: "sk-ant-oat" } });
    fireEvent.click(screen.getByRole("button", { name: "Start with Claude Code" }));

    await waitFor(() =>
      expect(onboarding.giveMachineLogin).toHaveBeenCalledWith(
        expect.objectContaining({ id: "c1" }),
        "claude",
        { kind: "setup-token", credential: "sk-ant-oat" },
      ),
    );

    const signedIn = { ...localController, status: { providers: [{ provider: "claude", installed: true, auth: "ok", auth_source: "sealed" }] } } as Controller;
    setControllers([signedIn]);

    await waitFor(
      () =>
        expect(onboarding.createBuddy).toHaveBeenCalledWith({
          controllerId: "c1",
          provider: "claude",
          person: { name: "Ada Lovelace", email: "ada@example.com" },
        }),
      { timeout: 6000 }
    );
  }, 15000);

  it("signs Claude Code in with a browser on a device of your own", async () => {
    device.snapshot = snapshot({ available: false, machine: null, controller: null });
    const localController = controller("missing");
    setControllers([localController]);
    const url = "https://claude.ai/oauth/authorize?code=true";
    management.startBrowserSignIn.mockResolvedValue("op-b");
    management.browserSignIn
      .mockResolvedValueOnce({ state: "open", url, userCode: null, needsCode: true })
      .mockResolvedValue({ state: "succeeded" });
    management.sendSignInCode.mockResolvedValue(undefined);
    onboarding.createBuddy.mockResolvedValue({ agentId: "a1", name: buddy.name });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Set up AI provider" }, { timeout: 6000 }));
    fireEvent.click(screen.getByRole("button", { name: /Claude/, pressed: false }));
    expect(screen.getByLabelText("Sign in with browser").getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByPlaceholderText("Setup token")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start with Claude Code" }));

    await waitFor(() => expect(management.startBrowserSignIn).toHaveBeenCalledWith("c1", "claude"));
    const page = await screen.findByRole("link", { name: /Open sign-in page/ }, { timeout: 4000 });
    expect(page.getAttribute("href")).toBe(url);
    fireEvent.change(screen.getByLabelText("Sign-in code"), { target: { value: "abc#def" } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    await waitFor(() => expect(management.sendSignInCode).toHaveBeenCalledWith("op-b", "abc#def"));

    const signedIn = { ...localController, status: { providers: [{ provider: "claude", installed: true, auth: "ok", auth_source: "sealed" }] } } as Controller;
    setControllers([signedIn]);
    await waitFor(() => expect(onboarding.createBuddy).toHaveBeenCalled(), { timeout: 8000 });
    expect(onboarding.giveMachineLogin).not.toHaveBeenCalled();
  }, 20000);

  it("goes back to the providers with the device's reason when the browser sign-in fails", async () => {
    device.snapshot = snapshot({ available: false, machine: null, controller: null });
    setControllers([controller("missing")]);
    management.startBrowserSignIn.mockResolvedValue("op-b");
    management.browserSignIn.mockResolvedValue({ state: "failed", message: "That code wasn't accepted." });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Set up AI provider" }, { timeout: 6000 }));
    fireEvent.click(screen.getByRole("button", { name: /Claude/, pressed: false }));
    fireEvent.click(screen.getByRole("button", { name: "Start with Claude Code" }));
    expect(await screen.findByText("That code wasn't accepted.", {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByText(/Pick an AI provider to power switch-buddy/)).toBeTruthy();
  }, 15000);
});
