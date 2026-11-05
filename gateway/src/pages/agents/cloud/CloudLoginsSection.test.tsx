import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as logins from "../../../data/cloudLogins";
import * as management from "../../../data/management";
import CloudLoginsSection, { WITHDRAW_TEXT } from "./CloudLoginsSection";

vi.mock("../../../data/cloudLogins", async (original) => ({
  ...(await original<typeof import("../../../data/cloudLogins")>()),
  listCloudLogins: vi.fn(),
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

beforeEach(() => {
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
    render(<CloudLoginsSection controllerId="box-ctl" askFor={null} onAsked={() => {}} />);
    expect(await screen.findByText("Claude")).toBeTruthy();
    expect(screen.queryByText("Cursor")).toBeNull();
    expect(within(screen.getByTestId("login-claude")).getByText("Login set")).toBeTruthy();
    expect(within(screen.getByTestId("login-codex")).getByText("No login yet")).toBeTruthy();
    expect(document.body.textContent).not.toContain("abc"); // not even the key id
    expect(logins.listCloudLogins).toHaveBeenCalledWith("box-ctl");
  });

  it("withdraws after asking, then says the box is waiting for a new login", async () => {
    render(<CloudLoginsSection controllerId="box-ctl" askFor={null} onAsked={() => {}} />);
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

  it("asks for a new cloud agent's login straight away", async () => {
    const onAsked = vi.fn();
    render(<CloudLoginsSection controllerId="box-ctl" askFor="codex" onAsked={onAsked} />);
    expect((await screen.findByTestId("login-dialog")).textContent).toBe("codex");
    expect(onAsked).toHaveBeenCalled();
  });
});
