import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as logins from "../../../data/cloudLogins";
import * as management from "../../../data/management";
import type { CloudMachine } from "../../../data/hostedCloud";
import type { Operation } from "../../../data/management";
import CloudLoginsSection, { STATUS_TEXT, WITHDRAW_TEXT } from "./CloudLoginsSection";

vi.mock("../../../data/cloudLogins", async (original) => ({
  ...(await original<typeof import("../../../data/cloudLogins")>()),
  listCloudLogins: vi.fn(),
  listOperations: vi.fn(),
  withdrawCloudLogin: vi.fn(),
  waitForOperation: vi.fn(),
}));
vi.mock("../../../data/management", async (original) => ({
  ...(await original<typeof import("../../../data/management")>()),
  fetchProviders: vi.fn(),
}));
vi.mock("./CloudLoginDialog", () => ({
  default: ({ open, provider }: { open: boolean; provider: string }) =>
    open ? <div data-testid="login-dialog">{provider}</div> : null,
}));

const MACHINE = { machine_id: "m-1", state: "ready", controller_id: "box-ctl", agents: [] } as unknown as CloudMachine;

const op = (state: Operation["state"], created_at: string, provider = "claude", kind = "provider.login") =>
  ({ id: `op-${created_at}`, kind, state, params: { provider }, created_at }) as unknown as Operation;

function section() {
  return render(
    <CloudLoginsSection
      controllerId="box-ctl"
      machine={MACHINE}
      onCloudChanged={() => {}}
      askFor={null}
      onAsked={() => {}}
    />,
  );
}

const statusOf = async (provider: string) => (await screen.findByTestId(`login-status-${provider}`)).textContent;

beforeEach(() => {
  vi.mocked(logins.listOperations).mockResolvedValue([]);
  vi.mocked(management.fetchProviders).mockResolvedValue([
    { id: "cursor", label: "Cursor", advanced_fields: [] },
    { id: "claude", label: "Claude", advanced_fields: [] },
    { id: "codex", label: "Codex", advanced_fields: [] },
  ]);
  vi.mocked(logins.listCloudLogins).mockResolvedValue([
    { provider: "claude", revision: 3, key_id: "abc", updated_at: "2026-11-05T00:00:00Z" },
  ]);
  vi.mocked(logins.withdrawCloudLogin).mockResolvedValue({ controllerId: "box-ctl" });
  vi.mocked(logins.waitForOperation).mockResolvedValue("succeeded");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AI logins on your cloud", () => {
  it("lists only the providers a box takes, set or not, with nothing of the login", async () => {
    section();
    expect(await screen.findByText("Claude")).toBeTruthy();
    expect(screen.queryByText("Cursor")).toBeNull();
    expect(within(screen.getByTestId("login-claude")).getByText("Login set")).toBeTruthy();
    expect(within(screen.getByTestId("login-codex")).getByText("No login yet")).toBeTruthy();
    expect(document.body.textContent).not.toContain("abc"); // not even the key id
    expect(logins.listCloudLogins).toHaveBeenCalledWith("box-ctl");
  });

  it("withdraws after asking, then says the box is waiting for a new login", async () => {
    section();
    const button = within(await screen.findByTestId("login-claude")).getByRole("button", { name: "Withdraw" });
    // A destructive button, not low-contrast text: it cuts off the provider's agents.
    expect(button.className).toContain("MuiButton-containedError");
    fireEvent.click(button);
    expect(logins.withdrawCloudLogin).not.toHaveBeenCalled();
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Withdraw" }).className).toContain(
      "MuiButton-containedError",
    );
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Withdraw" }));
    await waitFor(() => expect(screen.getByText(WITHDRAW_TEXT.done)).toBeTruthy());
    expect(logins.withdrawCloudLogin).toHaveBeenCalledWith("claude");
    expect(vi.mocked(logins.waitForOperation).mock.calls[0]![1]).toMatchObject({ kind: "provider.recheck", provider: "claude" });
  });

  it("withdraw's Cancel is never disabled: closing stops the following, and the list reads again", async () => {
    vi.mocked(logins.waitForOperation).mockImplementation(
      (_id, _match, options) =>
        new Promise((resolve) => options?.signal?.addEventListener("abort", () => resolve(null))),
    );
    section();
    fireEvent.click(within(await screen.findByTestId("login-claude")).getByRole("button", { name: "Withdraw" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Withdraw" }));
    await waitFor(() => expect(logins.waitForOperation).toHaveBeenCalled());
    const cancel = within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    const reads = vi.mocked(logins.listCloudLogins).mock.calls.length;
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(vi.mocked(logins.waitForOperation).mock.calls[0]![2]!.signal!.aborted).toBe(true);
    await waitFor(() => expect(vi.mocked(logins.listCloudLogins).mock.calls.length).toBeGreaterThan(reads));
  });

  it("asks for a new cloud agent's login straight away", async () => {
    const onAsked = vi.fn();
    render(
      <CloudLoginsSection controllerId="box-ctl" machine={MACHINE} onCloudChanged={() => {}} askFor="codex" onAsked={onAsked} />,
    );
    expect((await screen.findByTestId("login-dialog")).textContent).toBe("codex");
    expect(onAsked).toHaveBeenCalled();
  });
});

describe("Login set only once the box confirms it", () => {
  it("says Waiting for your cloud while the box hasn't taken it, and reads again until it has", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(logins.listOperations).mockResolvedValue([op("pending", "2026-11-05T19:00:00Z")]);
      section();
      await waitFor(async () => expect(await statusOf("claude")).toBe(STATUS_TEXT.waiting));
      expect(within(screen.getByTestId("login-claude")).getByRole("button", { name: "Change" })).toBeTruthy();
      expect(logins.listOperations).toHaveBeenCalledWith("box-ctl");

      vi.mocked(logins.listOperations).mockResolvedValue([op("succeeded", "2026-11-05T19:00:00Z")]);
      await vi.advanceTimersByTimeAsync(logins.OPERATION_POLL_MS + 100);
      await waitFor(async () => expect(await statusOf("claude")).toBe(STATUS_TEXT.set));
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes by the latest login operation for that provider only", async () => {
    vi.mocked(logins.listOperations).mockResolvedValue([
      op("succeeded", "2026-11-05T18:00:00Z"),
      op("claimed", "2026-11-05T19:00:00Z"),
      op("failed", "2026-11-05T19:30:00Z", "codex"),
      op("failed", "2026-11-05T19:40:00Z", "claude", "provider.recheck"),
    ]);
    section();
    await waitFor(async () => expect(await statusOf("claude")).toBe(STATUS_TEXT.waiting));
  });

  it("says when the box couldn't sign in with it, and offers Try again", async () => {
    vi.mocked(logins.listOperations).mockResolvedValue([
      op("succeeded", "2026-11-05T18:00:00Z"),
      op("failed", "2026-11-05T19:00:00Z"),
    ]);
    section();
    await waitFor(async () => expect(await statusOf("claude")).toBe(STATUS_TEXT.failed));
    fireEvent.click(within(screen.getByTestId("login-claude")).getByRole("button", { name: "Try again" }));
    expect((await screen.findByTestId("login-dialog")).textContent).toBe("claude");
  });

  it("says when the box never took it (expired), and offers Try again", async () => {
    vi.mocked(logins.listOperations).mockResolvedValue([op("expired", "2026-11-05T19:00:00Z")]);
    section();
    await waitFor(async () => expect(await statusOf("claude")).toBe(STATUS_TEXT.missed));
    expect(within(screen.getByTestId("login-claude")).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("reads Couldn't read, never Login set, when the box's operations can't be read", async () => {
    vi.mocked(logins.listOperations).mockRejectedValue(new Error("502"));
    section();
    await waitFor(async () => expect(await statusOf("claude")).toBe("Couldn't read"));
  });
});
