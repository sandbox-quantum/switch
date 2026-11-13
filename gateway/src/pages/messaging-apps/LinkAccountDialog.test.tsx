import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../data/api";
import type { LinkCode } from "../../data/api";
import { bridgeDetail, linkedIdentity, pendingIdentity } from "../collaborations/testFixtures";
import LinkAccountDialog, { type LinkDialogOpen } from "./LinkAccountDialog";

vi.mock("../../data/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../data/api")>()),
  searchBridgeDirectory: vi.fn(),
  claimBridgeIdentity: vi.fn(),
  issueLinkCode: vi.fn(),
  cancelLinkRequest: vi.fn(),
  fetchMyIdentities: vi.fn(),
  fetchMyPendingIdentities: vi.fn(),
}));

const app = bridgeDetail({ bridge_id: "b1", bridge_type: "slack", display_name: "Acme Slack" });
const code: LinkCode = {
  code: "ABCD-EFGH",
  expires_at: "2026-11-10T12:30:00Z",
  expires_in_seconds: 1800,
  instructions: "Post `!link-account ABCD-EFGH` from that account.",
};

function open(dialog: LinkDialogOpen) {
  const onClose = vi.fn();
  render(<LinkAccountDialog open={dialog} currentUserId="u-ada" onClose={onClose} />);
  return onClose;
}

describe("LinkAccountDialog", () => {
  beforeEach(() => {
    vi.mocked(api.fetchMyIdentities).mockResolvedValue([]);
    vi.mocked(api.fetchMyPendingIdentities).mockResolvedValue([pendingIdentity({ id: "acct-1" })]);
    vi.mocked(api.issueLinkCode).mockResolvedValue(code);
    vi.mocked(api.cancelLinkRequest).mockResolvedValue();
    vi.mocked(api.searchBridgeDirectory).mockResolvedValue({
      source: "directory",
      note: null,
      users: [
        {
          external_user_id: "U-ada",
          username: "ada",
          display_name: "Ada Lovelace",
          email: null,
          known_external_user_id: null,
          claimed_by: [],
        },
      ],
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("goes back to the search when a link it started is cancelled", async () => {
    vi.mocked(api.claimBridgeIdentity).mockResolvedValue({
      id: "acct-1",
      bridge_id: "b1",
      external_user_id: "U-ada",
      external_username: "ada",
      claimed_by: [],
      link_request: { user_id: "u-ada", code },
    });
    const onClose = open({ app, confirm: null });
    fireEvent.change(screen.getByLabelText("Search Acme Slack"), { target: { value: "ada" } });
    const thisIsMe = await screen.findByRole("button", { name: "This is me: Ada Lovelace, @ada" });
    await act(async () => fireEvent.click(thisIsMe));
    expect(screen.getByRole("dialog", { name: "Confirm your Slack account" })).toBeTruthy();

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel link" })));

    expect(screen.getByRole("dialog", { name: "Link your Slack account" })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("announces the number to tap in a live region that was there before it", async () => {
    vi.mocked(api.claimBridgeIdentity).mockResolvedValue({
      id: "acct-1",
      bridge_id: "b1",
      external_user_id: "U-ada",
      external_username: "ada",
      claimed_by: [],
      link_request: {
        user_id: "u-ada",
        code: { ...code, prompt: { number: 42, sent: true, unavailable_reason: null, link: null } },
      },
    });
    open({ app, confirm: null });
    const live = screen.getAllByRole("status").find((el) => el.getAttribute("aria-live") === "polite")!;
    fireEvent.change(screen.getByLabelText("Search Acme Slack"), { target: { value: "ada" } });
    await waitFor(() => expect(live.textContent).toBe("1 person found."));

    const thisIsMe = await screen.findByRole("button", { name: "This is me: Ada Lovelace, @ada" });
    await act(async () => fireEvent.click(thisIsMe));

    expect(live.isConnected).toBe(true);
    expect(live.textContent).toBe("We sent @ada a message in Acme Slack. Tap 42 there.");
  });

  it("closes when a link opened from its row is cancelled", async () => {
    const onClose = open({ app, confirm: { identityId: "acct-1", username: "ada", kind: "pending" } });
    await screen.findByTestId("link-code");

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel link" })));

    expect(onClose).toHaveBeenCalledWith(null);
  });

  it("holds Escape while a request is in flight", async () => {
    let answer: (code: LinkCode) => void = () => {};
    vi.mocked(api.issueLinkCode).mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const onClose = open({ app, confirm: { identityId: "acct-1", username: "ada", kind: "pending" } });
    await waitFor(() => expect(api.issueLinkCode).toHaveBeenCalled());

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => answer(code));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledWith(null);
  });

  it("says what it linked when the code is posted", async () => {
    vi.mocked(api.fetchMyIdentities).mockResolvedValue([linkedIdentity({ id: "acct-1" })]);
    vi.mocked(api.fetchMyPendingIdentities).mockResolvedValue([]);
    const onClose = open({ app, confirm: { identityId: "acct-1", username: "ada", kind: "pending" } });

    await waitFor(() => expect(onClose).toHaveBeenCalledWith({ app, handle: "@ada", kind: "linked" }), {
      timeout: 3000,
    });
  });
});
