import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../../data/api";
import * as logins from "../../../data/cloudLogins";
import * as management from "../../../data/management";
import CloudDeleteDialog, { NOT_DELETED } from "./CloudDeleteDialog";

vi.mock("../../../data/api", async (original) => ({
  ...(await original<typeof import("../../../data/api")>()),
  deleteAgent: vi.fn(),
}));
vi.mock("../../../data/cloudLogins", async (original) => ({
  ...(await original<typeof import("../../../data/cloudLogins")>()),
  listCloudLogins: vi.fn(),
  withdrawCloudLogin: vi.fn(),
  waitForOperation: vi.fn(),
}));
vi.mock("../../../data/management", async (original) => ({
  ...(await original<typeof import("../../../data/management")>()),
  fetchManagedAgents: vi.fn(),
}));

const managed = (id: string, provider: string, controller = "box-ctl") =>
  ({ agent_id: id, name: id, display_name: null, controller_id: controller, definition: { provider } }) as never;
const login = (provider: string) => ({ provider, revision: 1, key_id: "k", updated_at: "2026-11-05T00:00:00Z" });

let calls: string[];

beforeEach(() => {
  calls = [];
  vi.mocked(management.fetchManagedAgents).mockResolvedValue([managed("a1", "claude"), managed("a2", "codex")]);
  let withdrawn = false;
  vi.mocked(logins.listCloudLogins).mockImplementation(async () => (withdrawn ? [] : [login("claude")]));
  vi.mocked(logins.withdrawCloudLogin).mockImplementation(async () => {
    calls.push("withdraw");
    withdrawn = true;
    return { controllerId: "box-ctl" };
  });
  vi.mocked(logins.waitForOperation).mockResolvedValue("succeeded");
  vi.mocked(api.deleteAgent).mockImplementation(async () => {
    calls.push("delete");
    return { ok: true, bridge_cleanup_failures: [] };
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function open(onDeleted = vi.fn()) {
  render(<CloudDeleteDialog agent={{ id: "a1", name: "web-frontend" }} controllerId="box-ctl" onClose={() => {}} onDeleted={onDeleted} />);
  return onDeleted;
}

describe("deleting a cloud agent from Switch web", () => {
  it("as the last agent using its login: withdraws, reads back, then deletes", async () => {
    const onDeleted = open();
    await waitFor(() => expect(screen.getByTestId("delete-plan").textContent).toMatch(/last agent/));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(calls).toEqual(["withdraw", "delete"]);
    expect(logins.withdrawCloudLogin).toHaveBeenCalledWith("claude");
    expect(vi.mocked(logins.waitForOperation).mock.calls[0]![1]).toMatchObject({ kind: "provider.recheck", provider: "claude" });
  });

  it("with others using its login: keeps the login, names them, and only deletes", async () => {
    vi.mocked(management.fetchManagedAgents).mockResolvedValue([managed("a1", "claude"), managed("docs-writer", "claude")]);
    const onDeleted = open();
    await waitFor(() => expect(screen.getByTestId("delete-plan").textContent).toMatch(/docs-writer still uses it/));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(calls).toEqual(["delete"]);
  });

  it("deletes nothing when the withdraw fails", async () => {
    vi.mocked(logins.withdrawCloudLogin).mockRejectedValue(new Error("refused"));
    open();
    await waitFor(() => expect(screen.getByTestId("delete-plan").textContent).toMatch(/last agent/));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.getByText(NOT_DELETED.withdraw)).toBeTruthy());
    expect(api.deleteAgent).not.toHaveBeenCalled();
  });

  it("deletes nothing when the read-back still shows the login", async () => {
    vi.mocked(logins.listCloudLogins).mockResolvedValue([login("claude")]);
    open();
    await waitFor(() => expect(screen.getByTestId("delete-plan").textContent).toMatch(/last agent/));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.getByText(NOT_DELETED.withdraw)).toBeTruthy());
    expect(api.deleteAgent).not.toHaveBeenCalled();
  });

  it("decides again at confirm time: an agent added since keeps the login", async () => {
    open();
    await waitFor(() => expect(screen.getByTestId("delete-plan").textContent).toMatch(/last agent/));
    vi.mocked(management.fetchManagedAgents).mockResolvedValue([managed("a1", "claude"), managed("new-one", "claude")]);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteAgent).toHaveBeenCalled());
    expect(logins.withdrawCloudLogin).not.toHaveBeenCalled();
  });

  it("deletes nothing when it can't read who else uses the login", async () => {
    vi.mocked(management.fetchManagedAgents).mockRejectedValue(new Error("down"));
    open();
    await waitFor(() => expect(screen.getByText(NOT_DELETED.read)).toBeTruthy());
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.deleteAgent).not.toHaveBeenCalled();
  });
});
