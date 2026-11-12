import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../data/api";
import type { BridgeDetail, LinkedIdentity, PendingIdentity } from "../../data/api";
import { bridgeDetail, linkedIdentity, pendingIdentity } from "../collaborations/testFixtures";
import type { MyAccounts } from "./useMyAccounts";
import YourAccountsSection from "./YourAccountsSection";

vi.mock("../../data/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../data/api")>()),
  cancelLinkRequest: vi.fn(),
  releaseBridgeIdentity: vi.fn(),
  issueLinkCode: vi.fn(),
  fetchMyIdentities: vi.fn(),
  fetchMyPendingIdentities: vi.fn(),
  searchBridgeDirectory: vi.fn(),
}));

function accounts(linked: LinkedIdentity[] | null, pending: PendingIdentity[] | null): MyAccounts {
  return { linked, pending, linkedReadAt: 1, pendingReadAt: 1, error: null, refresh: vi.fn() };
}

function section(apps: BridgeDetail[] | null, mine: MyAccounts, showHeading = true, standsHere = true) {
  render(
    <YourAccountsSection
      apps={apps}
      appsFailed={false}
      accounts={mine}
      logos={new Map()}
      currentUserId="u-ada"
      standsHere={standsHere}
      showHeading={showHeading}
    />,
  );
}

const slack = bridgeDetail({ bridge_id: "b1", bridge_type: "slack", display_name: "Acme Slack" });

describe("YourAccountsSection", () => {
  beforeEach(() => {
    vi.mocked(api.fetchMyIdentities).mockResolvedValue([]);
    vi.mocked(api.fetchMyPendingIdentities).mockResolvedValue([]);
    vi.mocked(api.cancelLinkRequest).mockResolvedValue();
    vi.mocked(api.releaseBridgeIdentity).mockResolvedValue();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("offers to link an app with no account linked", () => {
    section([slack], accounts([], []));

    expect(screen.getByText("Slack · Acme Slack")).toBeTruthy();
    expect(screen.getByText("Not linked")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Link an account in Acme Slack" }));
    expect(screen.getByRole("dialog", { name: "Link your Slack account" })).toBeTruthy();
  });

  it("lists every account in an app, each with its own actions", () => {
    section(
      [slack],
      accounts(
        [
          linkedIdentity({ id: "a1", external_username: "ada", linked_at: "2026-01-14T09:00:00Z" }),
          linkedIdentity({ id: "a2", external_username: "ada.old", verified: false }),
        ],
        [pendingIdentity({ id: "a3", external_username: "ada.new", requested_by_name: "bob" })],
      ),
    );

    const lines = screen.getAllByTestId("account-line");
    expect(lines).toHaveLength(3);
    expect(within(lines[0]!).getByText(/@ada · linked/)).toBeTruthy();
    expect(within(lines[0]!).getByRole("button", { name: "Unlink @ada in Acme Slack" })).toBeTruthy();
    expect(within(lines[1]!).getByText("Not confirmed")).toBeTruthy();
    expect(within(lines[1]!).getByRole("button", { name: "Confirm @ada.old in Acme Slack" })).toBeTruthy();
    expect(within(lines[1]!).getByRole("button", { name: "Unlink @ada.old in Acme Slack" })).toBeTruthy();
    expect(within(lines[2]!).getByText("@ada.new · Waiting for confirmation · started by bob")).toBeTruthy();
    expect(within(lines[2]!).getByRole("button", { name: "Finish linking @ada.new in Acme Slack" })).toBeTruthy();
    expect(within(lines[2]!).getByRole("button", { name: "Cancel link to @ada.new in Acme Slack" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Link another account in Acme Slack" })).toBeTruthy();
  });

  it("asks before unlinking, then unlinks that account", async () => {
    const mine = accounts([linkedIdentity({ id: "a1", external_username: "ada" })], []);
    section([slack], mine);

    fireEvent.click(screen.getByRole("button", { name: "Unlink @ada in Acme Slack" }));
    const dialog = screen.getByRole("dialog", { name: "Unlink chat account" });
    expect(within(dialog).getByText(/@ada in Acme Slack will stop being recognised as you. Agents there will treat/)).toBeTruthy();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Unlink" })));

    expect(api.releaseBridgeIdentity).toHaveBeenCalledWith("b1", "a1");
    expect(mine.refresh).toHaveBeenCalled();
  });

  it("cancels a waiting link without unlinking anything", async () => {
    const mine = accounts([], [pendingIdentity({ id: "a3" })]);
    section([slack], mine);

    await act(async () => fireEvent.click(screen.getByRole("button", { name: /^Cancel link to/ })));

    expect(api.cancelLinkRequest).toHaveBeenCalledWith("b1", "a3");
    // Its row goes once the list is read again; focus waits on the app's own
    // button rather than falling to the top of the page.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Link an account in Acme Slack" }));
    expect(api.releaseBridgeIdentity).not.toHaveBeenCalled();
    expect(mine.refresh).toHaveBeenCalled();
  });

  it("opens the confirmation for a waiting link straight away", async () => {
    vi.mocked(api.fetchMyPendingIdentities).mockResolvedValue([pendingIdentity({ id: "a3" })]);
    vi.mocked(api.issueLinkCode).mockResolvedValue({
      code: "ABCD-EFGH",
      expires_at: "2026-11-10T12:30:00Z",
      expires_in_seconds: 1800,
      instructions: "Post `!link-account ABCD-EFGH` from that account.",
    });
    section([slack], accounts([], [pendingIdentity({ id: "a3" })]));

    fireEvent.click(screen.getByRole("button", { name: /^Finish linking/ }));

    expect(screen.getByRole("dialog", { name: "Confirm your Slack account" })).toBeTruthy();
    expect(await screen.findByTestId("link-code")).toBeTruthy();
    expect(api.issueLinkCode).toHaveBeenCalledWith("b1", "a3");
  });

  it("greys out linking in an app that isn't running, and still lets an account go", () => {
    section(
      [{ ...slack, status: "error" }],
      accounts([], [pendingIdentity({ id: "a3" })]),
    );

    expect(screen.getByText("Error")).toBeTruthy();
    // Said in the row, where a keyboard can reach it.
    expect(screen.getByText(/Acme Slack isn't running, so Switch can't look accounts up/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Link an account in Acme Slack" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /^Finish linking/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /^Cancel link to/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("says when there are no apps, and when the accounts could not be read", () => {
    section([], accounts([], []));
    expect(screen.getByText("No messaging apps are connected to this workspace yet.")).toBeTruthy();
    cleanup();

    section([slack], { ...accounts(null, null), error: "Failed" });
    expect(screen.getByText(/Could not load your accounts/)).toBeTruthy();
  });

  it("leaves the heading out where the list is the whole page", () => {
    section([slack], accounts([], []), false);
    expect(screen.queryByRole("heading", { name: "Your accounts" })).toBeNull();
  });

  it("says what unlinking leaves when another account in the app stays linked", () => {
    section(
      [slack],
      accounts(
        [
          linkedIdentity({ id: "a1", external_username: "ada" }),
          linkedIdentity({ id: "a2", external_username: "ada.work" }),
        ],
        [],
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Unlink @ada in Acme Slack" }));
    expect(screen.getByText(/You stay linked there as @ada.work/)).toBeTruthy();
  });

  it("offers a waiting link's app another account only once one counts", () => {
    section([slack], accounts([], [pendingIdentity({ id: "a3" })]));
    expect(screen.getByRole("button", { name: "Link an account in Acme Slack" })).toBeTruthy();
  });

  it("says when the accounts could not be refreshed, rather than looking current", () => {
    section([slack], { ...accounts([linkedIdentity({ bridge_id: "b1" })], []), error: "Bad gateway" });

    expect(screen.getByText(/@ada · linked/)).toBeTruthy();
    expect(screen.getByText(/Couldn't refresh your accounts, so this may be out of date: Bad gateway/)).toBeTruthy();
  });

  it("offers the platform operator nothing to link in a workspace they don't belong to", () => {
    section([slack], accounts([], []), true, false);

    expect(screen.getByText(/You're here as the platform operator/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Link/ })).toBeNull();
  });

  it("opens the app in its platform, for everyone", () => {
    section([{ ...slack, home_url: "https://acme.slack.com" }], accounts([], []));
    expect(screen.getByRole("link", { name: "Open Acme Slack" }).getAttribute("href")).toBe("https://acme.slack.com");
  });
});
