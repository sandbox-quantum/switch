import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Controller, ManagedAgent } from "../../data/management";
import MachinesPage from "./MachinesPage";

const laptop: Controller = {
  id: "c1",
  name: "laptop",
  description: null,
  kind: "daemon",
  platform: { os: "linux", arch: "x64", os_version: "6.1" },
  version: "0.1.0",
  state: "online",
  last_seen_at: new Date().toISOString(),
  connection: {
    connected_at: new Date().toISOString(),
    disconnected_at: null,
    disconnect_reason: null,
  },
  assignment_revision: 3,
  created_at: "2026-10-01T00:00:00Z",
  revoked_at: null,
  status: {
    seq: 1,
    observed_at: new Date().toISOString(),
    controller: { version: "0.1.0", protocol: 1, assignment_revision: 3 },
    machine: {
      platform: { os: "linux", arch: "x64", os_version: "6.1" },
      disk_free_bytes: 1,
      disk_total_bytes: 2,
      mem_free_bytes: 1,
      mem_total_bytes: 2,
      sessions_running: 0,
      sessions_max: 0,
    },
    providers: [
      {
        provider: "claude",
        installed: true,
        version: "2.0",
        auth: "ok",
        auth_source: "local",
        checked_at: new Date().toISOString(),
      },
      {
        provider: "codex",
        installed: true,
        version: "0.9",
        auth: "expired",
        auth_source: "local",
        checked_at: new Date().toISOString(),
        reason: "provider_login_expired",
      },
    ],
    tools: [],
    agents: [
      {
        agent_id: "a1",
        applied_revision: 2,
        process: "failed",
        attached: false,
        sessions: { active: 0, ids: [] },
        restarts_10m: 0,
        oom_kills: 0,
        since: new Date().toISOString(),
        reason: "invalid_credential",
        detail: "Switch refused the agent key",
      },
    ],
  },
};

const pmAgent: ManagedAgent = {
  agent_id: "a1",
  name: "pm-agent",
  display_name: null,
  icon_url: null,
  description: "Writes PRDs",
  controller_id: "c1",
  controller_state: "online",
  desired_state: "running",
  revision: 2,
  definition: {
    provider: "claude",
    model: null,
    instructions: "",
    auto_approve: false,
    directory: null,
    isolation: "shared",
    advanced_config: {},
  },
  status: laptop.status!.agents[0],
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
};

type Call = { path: string; method: string; body: unknown };

function mockManagement(routes: Record<string, [number, unknown]>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^\/gateway\/management/, "");
      const method = init?.method ?? "GET";
      calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      const [status, body] = routes[`${method} ${path}`] ?? [404, { detail: "Not Found" }];
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return calls;
}

describe("MachinesPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows machines with their provider state and agents with what they reported", async () => {
    mockManagement({
      "GET /controllers": [200, [laptop]],
      "GET /agents": [200, [pmAgent]],
      "GET /operations": [200, []],
    });
    render(<MachinesPage />);
    expect((await screen.findAllByText("laptop")).length).toBe(2);
    expect(screen.getByText("Codex: login expired")).toBeTruthy();
    expect(screen.getByText("pm-agent")).toBeTruthy();
    expect(screen.getByText("failed: invalid_credential")).toBeTruthy();
  });

  it("shows a revoked machine's agents as not running, whatever it last reported", async () => {
    const revoked: Controller = {
      ...laptop,
      state: "revoked",
      revoked_at: new Date().toISOString(),
      status: {
        ...laptop.status!,
        agents: [{ ...laptop.status!.agents[0]!, process: "running", reason: undefined, detail: undefined }],
      },
    };
    mockManagement({
      "GET /controllers": [200, [revoked]],
      "GET /agents": [
        200,
        [{ ...pmAgent, controller_state: "revoked", status: revoked.status!.agents[0] }],
      ],
      "GET /operations": [200, []],
    });
    render(<MachinesPage />);
    expect(await screen.findByText("None (revoked)")).toBeTruthy();
    expect(screen.getByText("not running: machine revoked")).toBeTruthy();
    expect(screen.queryByText("1 / 1")).toBeNull();
    // Only what is wanted says running; nothing claims the agent actually is.
    expect(screen.getAllByText("running")).toHaveLength(1);
  });

  it("shows a machine that stopped as offline, and its agents as unreachable", async () => {
    const stopped: Controller = {
      ...laptop,
      state: "offline",
      connection: {
        ...laptop.connection!,
        disconnected_at: new Date().toISOString(),
        disconnect_reason: "socket_closed",
      },
    };
    mockManagement({
      "GET /controllers": [200, [stopped]],
      "GET /agents": [200, [{ ...pmAgent, controller_state: "offline" }]],
      "GET /operations": [200, []],
    });
    render(<MachinesPage />);
    expect(await screen.findByText("offline")).toBeTruthy();
    expect(screen.getByText("Not connected")).toBeTruthy();
    expect(screen.getByText("machine offline")).toBeTruthy();
    expect(screen.queryByText("failed: invalid_credential")).toBeNull();
  });

  it("shows a machine that never connected as unknown", async () => {
    mockManagement({
      "GET /controllers": [200, [{ ...laptop, state: "unknown", connection: null, status: null }]],
      "GET /agents": [200, []],
      "GET /operations": [200, []],
    });
    render(<MachinesPage />);
    expect(await screen.findByText("unknown")).toBeTruthy();
    expect(screen.getByText("Unknown")).toBeTruthy();
  });

  it("describes revoking without per-agent keys", async () => {
    mockManagement({
      "GET /controllers": [200, [laptop]],
      "GET /agents": [200, [pmAgent]],
      "GET /operations": [200, []],
    });
    render(<MachinesPage />);
    fireEvent.click(await screen.findByLabelText("Revoke laptop"));
    const text = (await screen.findByText(/loses access to Switch immediately/)).textContent ?? "";
    expect(text).not.toMatch(/key/);
    expect(text).toMatch(/stay placed, and offline, until you move them/);
  });

  it("says when agent management is off instead of showing an empty page", async () => {
    mockManagement({});
    render(<MachinesPage />);
    expect(
      await screen.findByText(/Agent management is not enabled on this server/),
    ).toBeTruthy();
  });

  it("stops a running agent by changing what is wanted", async () => {
    const calls = mockManagement({
      "GET /controllers": [200, [laptop]],
      "GET /agents": [200, [pmAgent]],
      "GET /operations": [200, []],
      "PATCH /agents/a1": [200, { ...pmAgent, desired_state: "stopped" }],
    });
    render(<MachinesPage />);
    fireEvent.click(await screen.findByLabelText("Stop pm-agent"));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")).toEqual({
        path: "/agents/a1",
        method: "PATCH",
        body: { desired_state: "stopped" },
      }),
    );
  });

  it("renames a machine and describes it, sending only what changed", async () => {
    const calls = mockManagement({
      "GET /controllers": [200, [laptop]],
      "GET /agents": [200, [pmAgent]],
      "GET /operations": [200, []],
      "PATCH /controllers/c1": [
        200,
        { ...laptop, name: "build-box", description: "Under the desk" },
      ],
    });
    render(<MachinesPage />);
    fireEvent.click(await screen.findByLabelText("Edit machine laptop"));
    const name = await screen.findByLabelText(/^Name/);
    fireEvent.change(name, { target: { value: "  build-box " } });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Under the desk" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")).toEqual({
        path: "/controllers/c1",
        method: "PATCH",
        body: { name: "build-box", description: "Under the desk" },
      }),
    );
    expect(await screen.findByText("Saved build-box")).toBeTruthy();
  });

  it("will not save a machine without a name", async () => {
    const calls = mockManagement({
      "GET /controllers": [200, [{ ...laptop, description: "Old note" }]],
      "GET /agents": [200, []],
      "GET /operations": [200, []],
    });
    render(<MachinesPage />);
    expect(await screen.findByText("Old note")).toBeTruthy();
    fireEvent.click(await screen.findByLabelText("Edit machine laptop"));
    fireEvent.change(await screen.findByLabelText(/^Name/), { target: { value: "   " } });
    expect(screen.getByText("A machine needs a name.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("shows a refusal from the server in words", async () => {
    mockManagement({
      "GET /controllers": [200, [laptop]],
      "GET /agents": [200, [pmAgent]],
      "GET /operations": [200, []],
      "POST /operations": [
        409,
        {
          error: {
            code: "controller_offline",
            message: "The machine laptop has not reported recently.",
            retryable: true,
          },
        },
      ],
    });
    render(<MachinesPage />);
    fireEvent.click(await screen.findByLabelText("Restart pm-agent"));
    expect(
      await screen.findByText("The machine laptop has not reported recently."),
    ).toBeTruthy();
  });
});
