import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrganizationDevices, WorkspaceDevice, WorkspaceManagedAgent } from "../../../data/management";
import { answerFetch } from "../../../test/answerFetch";
import OrganizationDevicesSettings from "./OrganizationDevicesSettings";

vi.mock("../../../components/DataTable", () => import("../../../test/FakeDataTable"));

const CORE = { workspace_id: "w1", workspace_name: "Core" };
const LAB = { workspace_id: "w2", workspace_name: "Lab" };

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
    owner_id: "u2",
    owner_name: "Grace",
    providers: ["claude"],
    agents_total: 1,
    agents_running: 1,
    can_edit: false,
    can_recheck: false,
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
    controller_id: "lab-box",
    controller_name: "lab-box",
    controller_kind: "console",
    controller_state: "online",
    desired_state: "running",
    process: "running",
    owner_id: "u2",
    owner_name: "Grace",
    can_edit: false,
    can_delete: true,
    ...extra,
  };
}

function serve(data: OrganizationDevices) {
  return answerFetch({
    "GET /organizations/current/devices": [200, data],
    "GET /management/providers": [200, { providers: [{ id: "claude", label: "Claude Code", advanced_fields: [] }] }],
    "DELETE /organizations/current/workspaces/w2/devices/lab-box": [200, { ok: true }],
    "DELETE /organizations/current/workspaces/w2/managed-agents/scout": [200, { ok: true }],
  });
}

async function menuOf(rowId: string, name: string): Promise<string[]> {
  fireEvent.click(within(await screen.findByTestId(`row-${rowId}`)).getByRole("button", { name: `Actions for ${name}` }));
  return within(await screen.findByRole("menu"))
    .getAllByRole("menuitem")
    .map((item) => item.textContent ?? "");
}

describe("OrganizationDevicesSettings", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists every workspace's devices and agents with the workspace each is in", async () => {
    serve({
      devices: [{ ...device("laptop"), ...CORE }, { ...device("lab-box"), ...LAB }],
      managed_agents: [{ ...managed("scout"), ...LAB }],
    });
    render(<OrganizationDevicesSettings organizationName="Acme" />);

    expect(await screen.findByText("The devices that run agents across Acme.")).toBeTruthy();
    expect(within(await screen.findByTestId("row-laptop")).getByText("Core")).toBeTruthy();
    expect(within(screen.getByTestId("row-lab-box")).getByText("Lab")).toBeTruthy();
    expect(within(screen.getByTestId("row-scout")).getByText("Lab")).toBeTruthy();
    // Only what an admin of the workspace does: what the owner does stays on
    // the workspace's own page.
    expect(await menuOf("lab-box", "lab-box")).toEqual(["Remove"]);
  });

  it("removes a device in its own workspace, saying whose and where", async () => {
    const calls = serve({ devices: [{ ...device("lab-box"), ...LAB }], managed_agents: [] });
    render(<OrganizationDevicesSettings organizationName="Acme" />);

    await menuOf("lab-box", "lab-box");
    fireEvent.click(screen.getByRole("menuitem", { name: /Remove/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Grace's device lab-box, in Lab, stops running agents/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    expect(await screen.findByText("Removed lab-box.")).toBeTruthy();
    expect(
      calls.some((call) => call.method === "DELETE" && call.path === "/organizations/current/workspaces/w2/devices/lab-box"),
    ).toBe(true);
  });

  it("stops managing an agent in its own workspace", async () => {
    const calls = serve({ devices: [], managed_agents: [{ ...managed("scout"), ...LAB }] });
    render(<OrganizationDevicesSettings organizationName="Acme" />);

    expect(await menuOf("scout", "scout")).toEqual(["Stop managing"]);
    fireEvent.click(screen.getByRole("menuitem", { name: /Stop managing/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Stop managing scout, in Lab\?/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop managing" }));

    expect(await screen.findByText("Stopped managing scout.")).toBeTruthy();
    expect(
      calls.some(
        (call) => call.method === "DELETE" && call.path === "/organizations/current/workspaces/w2/managed-agents/scout",
      ),
    ).toBe(true);
  });

  it("says a cloud device is Switch's to remove", async () => {
    serve({
      devices: [{ ...device("cloud-1", { type: "cloud", kind: "ec2", can_remove: false }), ...CORE }],
      managed_agents: [],
    });
    render(<OrganizationDevicesSettings organizationName="Acme" />);

    expect(await menuOf("cloud-1", "cloud-1")).toEqual(["RemoveSwitch manages cloud devices."]);
  });

  it("shows why the list could not load, with a retry", async () => {
    answerFetch({
      "GET /organizations/current/devices": [403, { detail: "Organization admin access required" }],
      "GET /management/providers": [200, { providers: [] }],
    });
    render(<OrganizationDevicesSettings organizationName="Acme" />);

    expect(await screen.findByText(/Couldn't load the devices: Organization admin access required/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
