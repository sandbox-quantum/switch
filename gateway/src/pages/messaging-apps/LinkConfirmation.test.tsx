import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../data/api";
import type { LinkCode } from "../../data/api";
import { bridgeDetail, linkedIdentity, pendingIdentity } from "../collaborations/testFixtures";
import type { LinkTarget } from "./chatAccounts";
import LinkConfirmation from "./LinkConfirmation";

vi.mock("../../data/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../data/api")>()),
  issueLinkCode: vi.fn(),
  cancelLinkRequest: vi.fn(),
  releaseBridgeIdentity: vi.fn(),
  fetchMyIdentities: vi.fn(),
  fetchMyPendingIdentities: vi.fn(),
}));

const code = (overrides: Partial<LinkCode> = {}): LinkCode => ({
  code: "ABCD-EFGH",
  expires_at: "2026-11-10T12:30:00Z",
  expires_in_seconds: 1800,
  instructions: "Post `!link-account ABCD-EFGH` from that account in any channel Switch is in.",
  ...overrides,
});

const pending: LinkTarget = { identityId: "acct-1", username: "ada", kind: "pending" };
const older: LinkTarget = { identityId: "acct-1", username: "ada", kind: "unverified" };
const app = bridgeDetail({ bridge_id: "b1", display_name: "Acme Slack", bridge_type: "slack" });

function show(props: Partial<Parameters<typeof LinkConfirmation>[0]> = {}) {
  const handlers = {
    onBusy: vi.fn(),
    onConfirmed: vi.fn(),
    onCancelled: vi.fn(),
    onStartAgain: vi.fn(),
  };
  render(
    <StrictMode>
      <LinkConfirmation app={app} target={pending} initialCode={null} {...handlers} {...props} />
    </StrictMode>,
  );
  return handlers;
}

describe("LinkConfirmation", () => {
  beforeEach(() => {
    // Waiting: the link is still pending and nothing is linked yet.
    vi.mocked(api.fetchMyIdentities).mockResolvedValue([]);
    vi.mocked(api.fetchMyPendingIdentities).mockResolvedValue([pendingIdentity({ id: "acct-1" })]);
    vi.mocked(api.issueLinkCode).mockResolvedValue(code());
    vi.mocked(api.cancelLinkRequest).mockResolvedValue();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("asks for one code per opening, even when React runs the effect twice", async () => {
    show();

    expect(await screen.findByTestId("link-code")).toHaveProperty("textContent", "ABCD-EFGH");
    expect(api.issueLinkCode).toHaveBeenCalledOnce();
    expect(api.issueLinkCode).toHaveBeenCalledWith("b1", "acct-1");
  });

  it("shows the code a claim came back with, without asking for another", async () => {
    show({ initialCode: code({ code: "WXYZ-2345" }) });

    expect(screen.getByTestId("link-code").textContent).toBe("WXYZ-2345");
    await waitFor(() => expect(api.fetchMyPendingIdentities).toHaveBeenCalled());
    expect(api.issueLinkCode).not.toHaveBeenCalled();
  });

  it("shows how to post it and copies the whole command", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    show({ initialCode: code() });

    expect(screen.getByText("!link-account ABCD-EFGH")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy command" })));

    expect(writeText).toHaveBeenCalledWith("!link-account ABCD-EFGH");
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("says Linked once the account posts the code, then moves on", async () => {
    vi.mocked(api.fetchMyIdentities).mockResolvedValue([linkedIdentity({ id: "acct-1" })]);
    vi.mocked(api.fetchMyPendingIdentities).mockResolvedValue([]);
    const { onConfirmed } = show({ initialCode: code() });

    expect(await screen.findByText("Linked to @ada.")).toBeTruthy();
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledOnce(), { timeout: 3000 });
  });

  it("counts an older link as confirmed when it turns confirmed, though it was never pending", async () => {
    vi.mocked(api.fetchMyPendingIdentities).mockResolvedValue([]);
    vi.mocked(api.fetchMyIdentities).mockResolvedValue([linkedIdentity({ id: "acct-1", verified: false })]);
    show({ target: older, initialCode: code() });

    // Absent from the pending list is no sign of anything for an older link.
    await waitFor(() => expect(api.fetchMyPendingIdentities).toHaveBeenCalled());
    expect(screen.queryByText(/was cancelled/)).toBeNull();
    expect(screen.getByTestId("link-code")).toBeTruthy();
  });

  it("cancels a waiting link without unlinking anything", async () => {
    const { onCancelled } = show({ initialCode: code() });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel link" })));

    expect(api.cancelLinkRequest).toHaveBeenCalledWith("b1", "acct-1");
    expect(api.releaseBridgeIdentity).not.toHaveBeenCalled();
    expect(onCancelled).toHaveBeenCalledOnce();
  });

  it("withdraws only the code when confirming an older link", async () => {
    vi.mocked(api.fetchMyIdentities).mockResolvedValue([linkedIdentity({ id: "acct-1", verified: false })]);
    vi.mocked(api.fetchMyPendingIdentities).mockResolvedValue([]);
    show({ target: older, initialCode: code() });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Cancel confirmation" })),
    );

    expect(api.cancelLinkRequest).toHaveBeenCalledWith("b1", "acct-1");
    expect(api.releaseBridgeIdentity).not.toHaveBeenCalled();
  });

  it("notices a link cancelled somewhere else and offers to start again", async () => {
    vi.mocked(api.fetchMyPendingIdentities).mockResolvedValue([]);
    const { onStartAgain } = show({ initialCode: code() });

    expect(await screen.findByText(/The link to @ada was cancelled/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start again" }));
    expect(onStartAgain).toHaveBeenCalledOnce();
  });

  it("does not call a link cancelled when it was confirmed between the two reads", async () => {
    vi.mocked(api.fetchMyPendingIdentities).mockResolvedValue([]);
    // The first read of the linked accounts predates the code being posted;
    // the read that settles it finds the link.
    vi.mocked(api.fetchMyIdentities)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue([linkedIdentity({ id: "acct-1" })]);
    show({ initialCode: code() });

    expect(await screen.findByText("Linked to @ada.")).toBeTruthy();
    expect(screen.queryByText(/was cancelled/)).toBeNull();
  });

  it("says when the code has expired and offers a new one", async () => {
    show({ initialCode: code({ expires_in_seconds: 0 }) });

    expect(await screen.findByText(/This code has expired/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Copy command" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Get a new code" })));
    expect(api.issueLinkCode).toHaveBeenCalledOnce();
  });

  it("shows Switch's reason when a code is refused", async () => {
    vi.mocked(api.issueLinkCode).mockRejectedValue(
      new Error("This account cannot be linked to anyone. It is a bot."),
    );
    show();

    expect(await screen.findByText("This account cannot be linked to anyone. It is a bot.")).toBeTruthy();
  });

  it("opens the app to post the code in, where Switch knows its address", () => {
    render(
      <LinkConfirmation
        app={{ ...app, home_url: "https://acme.slack.com" }}
        target={pending}
        initialCode={code()}
        onBusy={vi.fn()}
        onConfirmed={vi.fn()}
        onCancelled={vi.fn()}
        onStartAgain={vi.fn()}
      />,
    );

    expect(screen.getByRole("link", { name: "Open Acme Slack" }).getAttribute("href")).toBe(
      "https://acme.slack.com",
    );
  });
});
