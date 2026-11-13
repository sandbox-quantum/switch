import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudMachine, WorkspaceDevice, WorkspaceManagedAgent } from "../../data/management";
import { answer, signedInAs } from "../../test/signedIn";
import DevicesPage, { withCloud } from "./DevicesPage";

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));
vi.mock("../../components/DataTable", () => import("../../test/FakeDataTable"));

function device(id: string, extra: Partial<WorkspaceDevice> = {}): WorkspaceDevice {
  return {
    id,
    name: id,
    description: null,
    kind: "console",
    type: "computer",
    platform: { os: "macos", arch: "arm64", os_version: "15" },
    version: "0.9.14",
    state: "online",
    last_seen_at: "2026-11-12T10:00:00Z",
    created_at: "2026-11-01T10:00:00Z",
    owner_id: "u1",
    owner_name: "Ada",
    providers: ["claude"],
    agents_total: 1,
    agents_running: 1,
    can_edit: true,
    can_recheck: true,
    can_remove: true,
    ...extra,
  };
}

function managed(id: string, extra: Partial<WorkspaceManagedAgent> = {}): WorkspaceManagedAgent {
  return {
    agent_id: id,
    name: id,
    display_name: null,
    provider: "claude",
    controller_id: "laptop",
    controller_name: "laptop",
    controller_kind: "console",
    controller_state: "online",
    desired_state: "running",
    process: "running",
    owner_id: "u1",
    owner_name: "Ada",
    can_edit: true,
    can_delete: true,
    ...extra,
  };
}

function cloud(extra: Partial<CloudMachine> = {}): CloudMachine {
  return {
    machine_id: "m1",
    state: "ready",
    desired_state: "running",
    stop_reason: null,
    stopped_by_admin: false,
    sleeping: false,
    revision: 3,
    error: null,
    error_code: null,
    retain_until: null,
    heartbeat_at: "2026-11-12T10:00:00Z",
    controller_id: null,
    ...extra,
  };
}

const THEIRS = device("grace-laptop", {
  owner_id: "u2",
  owner_name: "Grace",
  can_edit: false,
  can_recheck: false,
});

function serve(devices: WorkspaceDevice[], agents: WorkspaceManagedAgent[] = [], machines: CloudMachine[] = []) {
  return answer({
    "GET /management/workspace": [200, { devices, managed_agents: agents, operations: [] }],
    "GET /hosted-machines": [200, { available: machines.length > 0, machines }],
    "GET /management/providers": [200, { providers: [{ id: "claude", label: "Claude Code", advanced_fields: [] }] }],
    "DELETE /management/controllers/grace-laptop": [200, { ok: true }],
    "DELETE /agents/theirs": [200, { ok: true, bridge_cleanup_failures: [] }],
    "POST /management/operations": [201, { id: "op1" }],
  });
}

/** The items of a row's "…" menu: each label, with its reason when it is unavailable. */
async function menuOf(rowId: string, name: string): Promise<string[]> {
  fireEvent.click(within(await screen.findByTestId(`row-${rowId}`)).getByRole("button", { name: `Actions for ${name}` }));
  return within(await screen.findByRole("menu"))
    .getAllByRole("menuitem")
    .map((item) => item.textContent ?? "");
}

describe("DevicesPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows an admin everyone's devices, removing anyone's and refreshing their own", async () => {
    signedInAs("admin");
    serve([device("laptop"), THEIRS]);
    render(<DevicesPage />);

    expect(await screen.findByText("The devices that run agents in Acme.")).toBeTruthy();
    expect(within(screen.getByTestId("row-grace-laptop")).getByText("Grace")).toBeTruthy();
    expect(within(screen.getByTestId("row-laptop")).getByText("1 of 1 running")).toBeTruthy();
    expect(await menuOf("grace-laptop", "grace-laptop")).toEqual(["Remove"]);
  });

  it("removes someone else's device, saying whose it is", async () => {
    signedInAs("admin");
    const calls = serve([THEIRS]);
    render(<DevicesPage />);

    await menuOf("grace-laptop", "grace-laptop");
    fireEvent.click(screen.getByRole("menuitem", { name: /Remove/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Grace's device grace-laptop stops running agents/)).toBeTruthy();
    expect(within(dialog).getByText(/The agent on it stops, and runs again once it's put on another device/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    expect(await screen.findByText("Removed grace-laptop.")).toBeTruthy();
    expect(calls.some((call) => call.method === "DELETE" && call.path === "/management/controllers/grace-laptop")).toBe(true);
  });

  it("says why an offline device can't be refreshed", async () => {
    signedInAs("member");
    serve([device("laptop", { state: "offline" })]);
    render(<DevicesPage />);

    expect(await screen.findByText("Your devices that run agents in Acme.")).toBeTruthy();
    expect(await menuOf("laptop", "laptop")).toEqual(["Refreshlaptop is offline.", "Edit", "Remove"]);
  });

  it("asks an online device to report in", async () => {
    signedInAs("member");
    const calls = serve([device("laptop")]);
    render(<DevicesPage />);

    await menuOf("laptop", "laptop");
    fireEvent.click(screen.getByRole("menuitem", { name: /Refresh/ }));

    expect(await screen.findByText("Asked laptop to report in.")).toBeTruthy();
    const asked = calls.filter((call) => call.method === "POST" && call.path === "/management/operations");
    expect(asked.map((call) => call.body)).toEqual([
      { controller_id: "laptop", agent_id: null, kind: "provider.recheck", params: { provider: "claude" } },
    ]);
  });

  it("shows the owner's cloud device as Switch Console does, with nothing of it to rename or remove", async () => {
    signedInAs("member");
    serve(
      [device("cloud-1", { name: "Switch cloud", kind: "ec2", type: "cloud", can_edit: false, can_remove: false })],
      [],
      [cloud({ controller_id: "cloud-1", sleeping: true })],
    );
    render(<DevicesPage />);

    const row = within(await screen.findByTestId("row-cloud-1"));
    expect(row.getByText("Sleeping")).toBeTruthy();
    expect(row.getByText("Cloud")).toBeTruthy();
    expect(await menuOf("cloud-1", "Switch cloud")).toEqual([
      "Refresh",
      "Stop",
      "EditSwitch manages cloud devices.",
      "RemoveSwitch manages cloud devices.",
    ]);
  });

  it("offers an admin nothing to do with someone else's cloud device", async () => {
    signedInAs("admin");
    serve([
      device("grace-cloud", {
        name: "Switch cloud",
        kind: "ec2",
        type: "cloud",
        owner_id: "u2",
        owner_name: "Grace",
        can_edit: false,
        can_recheck: false,
        can_remove: false,
      }),
    ]);
    render(<DevicesPage />);

    const row = within(await screen.findByTestId("row-grace-cloud"));
    expect(row.getByText("Cloud")).toBeTruthy();
    expect(row.getByText("Online")).toBeTruthy();
    expect(row.queryByRole("button")).toBeNull();
  });

  it("holds the cloud device's actions while one is on its way", async () => {
    signedInAs("member");
    serve([], [], [cloud({ state: "ready" })]);
    const answered = vi.mocked(fetch);
    let release: (response: Response) => void = () => {};
    const served = answered.getMockImplementation();
    answered.mockImplementation(async (input, init) =>
      String(input).endsWith("/lifecycle")
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : (served as typeof fetch)(input, init),
    );
    render(<DevicesPage />);

    await menuOf("cloud:m1", "Switch cloud");
    fireEvent.click(screen.getByRole("menuitem", { name: /Stop/ }));
    expect(await menuOf("cloud:m1", "Switch cloud")).toContain("StopWaiting for your cloud device to answer.");
    release(new Response(JSON.stringify({ machine: cloud({ desired_state: "stopped" }) }), { status: 200 }));
    expect(await screen.findByText("Stopping your cloud device.")).toBeTruthy();
  });

  it("shows a cloud device still being set up", async () => {
    signedInAs("member");
    serve([], [], [cloud({ state: "provisioning" })]);
    render(<DevicesPage />);

    const row = within(await screen.findByTestId("row-cloud:m1"));
    expect(row.getByText("Switch cloud")).toBeTruthy();
    expect(row.getByText("Provisioning")).toBeTruthy();
  });

  it("disables what an agent on an offline device can't do, with the reason", async () => {
    signedInAs("member");
    serve([device("laptop", { state: "offline" })], [managed("helper", { controller_state: "offline" })]);
    render(<DevicesPage />);

    // Pausing is kept for when the device is back; restarting is only for now.
    expect(await menuOf("helper", "helper")).toEqual([
      "Pause",
      "Restartlaptop is offline.",
      "Edit",
      "Stop managing",
      "Delete",
    ]);
  });

  it("pauses an agent on an offline device, saying when it takes effect", async () => {
    signedInAs("member");
    const calls = answer({
      "GET /management/workspace": [
        200,
        {
          devices: [device("laptop", { state: "offline" })],
          managed_agents: [managed("helper", { controller_state: "offline" })],
          operations: [],
        },
      ],
      "GET /hosted-machines": [200, { available: false, machines: [] }],
      "GET /management/providers": [200, { providers: [] }],
      "PATCH /management/agents/helper": [200, {}],
    });
    render(<DevicesPage />);

    await menuOf("helper", "helper");
    fireEvent.click(screen.getByRole("menuitem", { name: /Pause/ }));

    expect(await screen.findByText("Pausing helper. laptop does it once it's back.")).toBeTruthy();
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ desired_state: "stopped" });
  });

  it("says why a removal was refused when the device went in the meantime", async () => {
    signedInAs("admin");
    answer({
      "GET /management/workspace": [200, { devices: [THEIRS], managed_agents: [], operations: [] }],
      "GET /hosted-machines": [200, { available: false, machines: [] }],
      "GET /management/providers": [200, { providers: [] }],
      "DELETE /management/controllers/grace-laptop": [
        404,
        { error: { code: "not_found", message: "Controller not found.", retryable: false } },
      ],
    });
    render(<DevicesPage />);

    await menuOf("grace-laptop", "grace-laptop");
    fireEvent.click(screen.getByRole("menuitem", { name: /Remove/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    expect(await within(dialog).findByText("Controller not found.")).toBeTruthy();
    expect(screen.queryByText("Removed grace-laptop.")).toBeNull();
  });

  it("lets an admin stop managing or delete someone else's agent, and nothing more", async () => {
    signedInAs("admin");
    const calls = serve(
      [THEIRS],
      [managed("theirs", { owner_id: "u2", owner_name: "Grace", controller_id: "grace-laptop", controller_name: "grace-laptop", can_edit: false })],
    );
    render(<DevicesPage />);

    expect(await menuOf("theirs", "theirs")).toEqual(["Stop managing", "Delete"]);
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Delete theirs\? It stops running on grace-laptop/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("Deleted theirs.")).toBeTruthy();
    expect(calls.some((call) => call.method === "DELETE" && call.path === "/agents/theirs")).toBe(true);
  });

  it("says when the devices can't be loaded", async () => {
    signedInAs("member");
    answer({
      "GET /management/workspace": [500, { error: { code: "internal", message: "boom", retryable: true } }],
      "GET /hosted-machines": [200, { available: false, machines: [] }],
      "GET /management/providers": [200, { providers: [] }],
    });
    render(<DevicesPage />);

    await waitFor(() => expect(screen.getByText(/Couldn't load the devices: boom/)).toBeTruthy());
  });
});

describe("withCloud", () => {
  const owner = { id: "u1", name: "Ada" };

  it("puts the machine on the row of the controller it enrolled as", () => {
    const rows = withCloud([device("cloud-1", { kind: "ec2", type: "cloud" })], [cloud({ controller_id: "cloud-1" })], owner, 0);
    expect(rows.map((row) => [row.id, row.cloud?.label])).toEqual([["cloud-1", "Ready"]]);
  });

  it("gives a machine that has not enrolled yet a row of its own", () => {
    const rows = withCloud([device("laptop")], [cloud()], owner, 0);
    expect(rows.map((row) => [row.id, row.type, row.owner_name])).toEqual([
      ["laptop", "computer", "Ada"],
      ["cloud:m1", "cloud", "Ada"],
    ]);
  });
});
