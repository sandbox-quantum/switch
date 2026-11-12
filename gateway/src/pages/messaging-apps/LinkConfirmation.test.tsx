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

/** Text on screen, leaving out the live region that repeats it for screen
 * readers. */
const SHOWN = { ignore: "[aria-live], script, style" };

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

    expect(await screen.findByText("Linked to @ada.", SHOWN)).toBeTruthy();
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledOnce(), { timeout: 3000 });
  });

  it("does not take an older link's absence from the pending list as a cancel", async () => {
    vi.mocked(api.fetchMyPendingIdentities).mockResolvedValue([]);
    vi.mocked(api.fetchMyIdentities).mockResolvedValue([linkedIdentity({ id: "acct-1", verified: false })]);
    show({ target: older, initialCode: code() });

    // Both lists read since the screen opened, and still no "cancelled".
    await waitFor(() => expect(api.fetchMyPendingIdentities).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.queryByText(/was cancelled/, SHOWN)).toBeNull();
    expect(screen.getByTestId("link-code")).toBeTruthy();
  });

  it("counts an older link as confirmed once it turns confirmed", async () => {
    vi.mocked(api.fetchMyPendingIdentities).mockResolvedValue([]);
    vi.mocked(api.fetchMyIdentities)
      .mockResolvedValueOnce([linkedIdentity({ id: "acct-1", verified: false })])
      .mockResolvedValueOnce([linkedIdentity({ id: "acct-1", verified: false })])
      .mockResolvedValue([linkedIdentity({ id: "acct-1", verified: true })]);
    const { onConfirmed } = show({ target: older, initialCode: code() });
    expect(screen.getByTestId("link-code")).toBeTruthy();

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Get a new code" })));

    expect(await screen.findByText("@ada is confirmed.", SHOWN)).toBeTruthy();
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledOnce(), { timeout: 3000 });
  });

  it("does not report a cancel when the code was posted a moment before", async () => {
    vi.mocked(api.cancelLinkRequest).mockRejectedValue(new api.ApiError(404, "gone", "gone"));
    const { onCancelled } = show({ initialCode: code() });
    await waitFor(() => expect(api.fetchMyIdentities).toHaveBeenCalled());
    vi.mocked(api.fetchMyIdentities).mockResolvedValue([linkedIdentity({ id: "acct-1" })]);
    vi.mocked(api.fetchMyPendingIdentities).mockResolvedValue([]);

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel link" })));

    expect(onCancelled).not.toHaveBeenCalled();
    expect(await screen.findByText("Linked to @ada.", SHOWN)).toBeTruthy();
  });

  it("says the app is gone when it was deleted while the code was up", async () => {
    vi.mocked(api.issueLinkCode).mockRejectedValue(new api.ApiError(404, "Bridge not found", "Bridge not found"));
    show();

    expect(await screen.findByText("Acme Slack is no longer connected to this workspace, so this link can't be finished.", SHOWN)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Get a new code" })).toBeNull();
  });

  it("keeps one live region a screen reader hears change", async () => {
    show({ initialCode: code() });
    const live = screen.getAllByRole("status").find((el) => el.getAttribute("aria-live") === "polite")!;

    expect(live.textContent).toBe("Waiting for the code to be posted from @ada.");
    vi.mocked(api.fetchMyIdentities).mockResolvedValue([linkedIdentity({ id: "acct-1" })]);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Get a new code" })));

    await waitFor(() => expect(live.textContent).toBe("Linked to @ada."));
    expect(live.isConnected).toBe(true);
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

    expect(await screen.findByText(/The link to @ada was cancelled/, SHOWN)).toBeTruthy();
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

    expect(await screen.findByText("Linked to @ada.", SHOWN)).toBeTruthy();
    expect(screen.queryByText(/was cancelled/, SHOWN)).toBeNull();
  });

  it("says when the code has expired and offers a new one", async () => {
    show({ initialCode: code({ expires_in_seconds: 0 }) });

    expect(await screen.findByText(/This code has expired/, SHOWN)).toBeTruthy();
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

    expect(screen.getByRole("link", { name: "Open in Acme Slack" }).getAttribute("href")).toBe(
      "https://acme.slack.com",
    );
  });

  it("does not spin when the first code is refused, and Cancel still closes", async () => {
    vi.mocked(api.issueLinkCode).mockRejectedValue(new Error("Bridge is not running — cannot check this account"));
    vi.mocked(api.cancelLinkRequest).mockRejectedValue(
      new api.ApiError(404, "That user has no link to this account waiting to be confirmed", "That user has no link to this account waiting to be confirmed"),
    );
    vi.mocked(api.fetchMyPendingIdentities).mockResolvedValue([]);
    vi.mocked(api.fetchMyIdentities).mockResolvedValue([linkedIdentity({ id: "acct-1", verified: false })]);
    const { onCancelled } = show({ target: older });

    expect(await screen.findByText("Bridge is not running — cannot check this account")).toBeTruthy();
    expect(screen.queryByText("Getting a code…")).toBeNull();
    expect(screen.getByText("No code yet.")).toBeTruthy();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Cancel confirmation" })),
    );
    expect(onCancelled).toHaveBeenCalledOnce();
  });

  it("says so when it can no longer tell whether the code was posted", async () => {
    vi.mocked(api.fetchMyIdentities).mockRejectedValue(new Error("Not authenticated"));
    show({ initialCode: code() });

    expect(await screen.findByText(/Can't check whether the link was confirmed: Not authenticated/)).toBeTruthy();
  });

  it("asks again when the read that settles a cancellation fails", { timeout: 10000 }, async () => {
    vi.mocked(api.fetchMyPendingIdentities).mockResolvedValue([]);
    vi.mocked(api.fetchMyIdentities)
      // The two reads on open (React runs the effect twice here) find nothing.
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      // The settling read fails once, then the next one finds nothing too.
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValue([]);
    show({ initialCode: code() });

    expect(await screen.findByText(/The link to @ada was cancelled/, SHOWN, { timeout: 6000 })).toBeTruthy();
  });

  describe("with a message to tap", () => {
    const sent = (overrides: Partial<api.LinkPrompt> = {}) =>
      code({ prompt: { number: 42, sent: true, unavailable_reason: null, link: "https://acme.slack.com/archives/D1", ...overrides } });

    it("leads with the number to tap, and keeps the code as the fallback", () => {
      show({ initialCode: sent() });

      expect(screen.getByText("Switch sent @ada a message in Acme Slack. Tap 42 there to finish linking.")).toBeTruthy();
      expect(screen.getByTestId("link-prompt-number").textContent).toBe("42");
      expect(screen.getByRole("link", { name: "Open in Acme Slack" }).getAttribute("href")).toBe(
        "https://acme.slack.com/archives/D1",
      );
      expect(screen.getByText(/Didn't get the message\? Post this from that account instead/)).toBeTruthy();
      expect(screen.getByTestId("link-code").textContent).toBe("ABCD-EFGH");
      expect(screen.getByRole("button", { name: "Send again" })).toBeTruthy();
      expect(screen.getByText(/Waiting for confirmation. The code expires at/)).toBeTruthy();
    });

    it("asks the confirmation of an older link the same way", () => {
      show({ target: older, initialCode: sent() });
      expect(screen.getByText(/Tap 42 there to confirm the link. The link keeps working meanwhile./)).toBeTruthy();
    });

    it("says why no message went out, and shows the code as the way", () => {
      show({
        initialCode: code({
          prompt: { number: 42, sent: false, unavailable_reason: "Teams can't send one.", link: null },
        }),
      });

      expect(screen.getByText("Couldn't message @ada directly: Teams can't send one.")).toBeTruthy();
      expect(screen.queryByTestId("link-prompt-number")).toBeNull();
      expect(screen.getByText("To finish linking @ada, post this from that account in Acme Slack.")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Get a new code" })).toBeTruthy();
    });

    it("says a link dropped while the message was up may have been declined", async () => {
      vi.mocked(api.fetchMyPendingIdentities).mockResolvedValue([]);
      show({ initialCode: sent() });

      expect(
        await screen.findByText(/The link to @ada was cancelled. It may have been declined in Acme Slack/, SHOWN),
      ).toBeTruthy();
    });

    it("notices an older link removed by Not me, though it was never pending", async () => {
      vi.mocked(api.fetchMyPendingIdentities).mockResolvedValue([]);
      vi.mocked(api.fetchMyIdentities)
        .mockResolvedValueOnce([linkedIdentity({ id: "acct-1", verified: false })])
        .mockResolvedValueOnce([linkedIdentity({ id: "acct-1", verified: false })])
        .mockResolvedValue([]);
      show({ target: older, initialCode: sent() });
      await screen.findByTestId("link-prompt-number");

      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send again" })));

      expect(await screen.findByText(/The link to @ada was removed. It may have been declined/, SHOWN)).toBeTruthy();
    });

    it("tells a screen reader which number to tap", () => {
      show({ initialCode: sent() });
      const live = screen.getAllByRole("status").find((el) => el.getAttribute("aria-live") === "polite")!;
      expect(live.textContent).toBe("Waiting for you to tap 42 in the message sent to @ada.");
    });
  });
});
