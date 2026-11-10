import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../../data/api";
import type { DirectoryPerson, LinkCode } from "../../data/api";
import { bridgeDetail, pendingIdentity } from "../collaborations/testFixtures";
import AccountSearch from "./AccountSearch";

vi.mock("../../data/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../data/api")>()),
  searchBridgeDirectory: vi.fn(),
  claimBridgeIdentity: vi.fn(),
}));

const app = bridgeDetail({ bridge_id: "b1", display_name: "Acme Slack" });

const person = (overrides: Partial<DirectoryPerson> = {}): DirectoryPerson => ({
  external_user_id: "U-ada",
  username: "ada",
  display_name: "Ada Lovelace",
  email: "ada@example.com",
  known_external_user_id: null,
  claimed_by: [],
  ...overrides,
});

const code: LinkCode = {
  code: "ABCD-EFGH",
  expires_at: "2026-11-10T12:30:00Z",
  expires_in_seconds: 1800,
  instructions: "Post `!link-account ABCD-EFGH` from that account.",
};

function search(props: Partial<Parameters<typeof AccountSearch>[0]> = {}) {
  const handlers = { onBusy: vi.fn(), onLinked: vi.fn(), onConfirm: vi.fn() };
  render(<AccountSearch app={app} currentUserId="u-ada" pending={[]} {...handlers} {...props} />);
  return handlers;
}

const type = (text: string) =>
  fireEvent.change(screen.getByLabelText("Search Acme Slack"), { target: { value: text } });

describe("AccountSearch", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("waits for two characters before asking the platform", async () => {
    vi.mocked(api.searchBridgeDirectory).mockResolvedValue({ source: "directory", note: null, users: [] });
    search();
    type("a");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(api.searchBridgeDirectory).not.toHaveBeenCalled();

    type("ad");
    await waitFor(() => expect(api.searchBridgeDirectory).toHaveBeenCalledWith("b1", "ad"));
    expect(await screen.findByText("Nobody in Acme Slack matches “ad”.")).toBeTruthy();
  });

  it("links the account picked, and waits on the code the claim returned", async () => {
    vi.mocked(api.searchBridgeDirectory).mockResolvedValue({
      source: "directory",
      note: null,
      users: [person()],
    });
    vi.mocked(api.claimBridgeIdentity).mockResolvedValue({
      id: "acct-1",
      bridge_id: "b1",
      external_user_id: "U-ada",
      external_username: "ada",
      claimed_by: [],
      link_request: { user_id: "u-ada", code },
    });
    const { onConfirm } = search();
    type("ada");

    const thisIsMe = await screen.findByRole("button", { name: "This is me" });
    await act(async () => fireEvent.click(thisIsMe));

    expect(api.claimBridgeIdentity).toHaveBeenCalledWith("b1", person());
    expect(onConfirm).toHaveBeenCalledWith(
      { identityId: "acct-1", username: "ada", kind: "pending" },
      code,
    );
  });

  it("is done at once when the claim comes back already confirmed", async () => {
    vi.mocked(api.searchBridgeDirectory).mockResolvedValue({ source: "directory", note: null, users: [person()] });
    vi.mocked(api.claimBridgeIdentity).mockResolvedValue({
      id: "acct-1",
      bridge_id: "b1",
      external_user_id: "U-ada",
      external_username: "ada",
      claimed_by: [{ user_id: "u-ada", user_name: "ada", verified: true, can_unlink: true }],
      link_request: null,
    });
    const { onLinked, onConfirm } = search();
    type("ada");

    const thisIsMe = await screen.findByRole("button", { name: "This is me" });
    await act(async () => fireEvent.click(thisIsMe));

    expect(onLinked).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("says who else is linked, and what is already yours", async () => {
    vi.mocked(api.searchBridgeDirectory).mockResolvedValue({
      source: "directory",
      note: null,
      users: [
        person({
          claimed_by: [{ user_id: "u-bob", user_name: "bob", verified: true, can_unlink: false }],
        }),
        person({
          external_user_id: "U-ada2",
          username: "ada.two",
          known_external_user_id: "acct-2",
          claimed_by: [{ user_id: "u-ada", user_name: "ada", verified: false, can_unlink: true }],
        }),
      ],
    });
    const { onConfirm } = search();
    type("ada");

    expect(await screen.findByText("Also linked to bob")).toBeTruthy();
    expect(screen.getByText("Linked, not confirmed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledWith(
      { identityId: "acct-2", username: "ada.two", kind: "unverified" },
      null,
    );
  });

  it("offers the code for a link already waiting rather than linking again", async () => {
    vi.mocked(api.searchBridgeDirectory).mockResolvedValue({ source: "directory", note: null, users: [person()] });
    const { onConfirm } = search({
      pending: [pendingIdentity({ id: "acct-1", bridge_id: "b1", external_user_id: "U-ada" })],
    });
    type("ada");

    fireEvent.click(await screen.findByRole("button", { name: "Show code" }));
    expect(onConfirm).toHaveBeenCalledWith({ identityId: "acct-1", username: "ada", kind: "pending" }, null);
    expect(api.claimBridgeIdentity).not.toHaveBeenCalled();
  });

  it("captions a list drawn from the accounts Switch has seen", async () => {
    vi.mocked(api.searchBridgeDirectory).mockResolvedValue({
      source: "known",
      note: "Telegram has no user directory.",
      users: [],
    });
    search({ app: { ...app, directory_search_supported: false } });

    expect(screen.getByText(/It has no directory, so you appear here once you have sent a message/)).toBeTruthy();
    type("ada");
    expect(await screen.findByText("Telegram has no user directory.")).toBeTruthy();
    expect(screen.getByText("Nobody Switch has seen in Acme Slack matches “ada”.")).toBeTruthy();
  });

  it("shows Switch's reason when a search or a claim is refused", async () => {
    vi.mocked(api.searchBridgeDirectory).mockRejectedValueOnce(
      new Error("Slack is answering too many searches. Try again in 30 seconds."),
    );
    search();
    type("ada");

    expect(await screen.findByText("Slack is answering too many searches. Try again in 30 seconds.")).toBeTruthy();
  });
});
