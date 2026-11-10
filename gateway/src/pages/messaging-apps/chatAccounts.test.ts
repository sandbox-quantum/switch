import { describe, expect, it } from "vitest";
import type { ClaimedAccount, LinkCode } from "../../data/api";
import { bridgeDetail, linkedIdentity, pendingIdentity } from "../collaborations/testFixtures";
import {
  accountsByApp,
  afterClaim,
  codeDeadline,
  commandsIn,
  findableNote,
  looksCancelled,
  unavailableReason,
} from "./chatAccounts";

const code: LinkCode = {
  code: "ABCD-EFGH",
  expires_at: "2026-11-10T12:30:00Z",
  expires_in_seconds: 1800,
  instructions: "Post `!link-account ABCD-EFGH` from that account in any channel Switch is in.",
};

const claimed = (overrides: Partial<ClaimedAccount>): ClaimedAccount => ({
  id: "acct-1",
  bridge_id: "b1",
  external_user_id: "U1",
  external_username: "ada",
  claimed_by: [],
  link_request: null,
  ...overrides,
});

describe("accountsByApp", () => {
  it("lists every account a person holds in an app, a waiting one beside one that counts", () => {
    const slack = bridgeDetail({ bridge_id: "b1", display_name: "Slack HQ" });
    const groups = accountsByApp(
      [slack],
      [
        linkedIdentity({ id: "a1", external_username: "ada" }),
        linkedIdentity({ id: "a2", external_username: "ada.old", verified: false }),
      ],
      [pendingIdentity({ id: "a3", external_username: "ada.new", requested_by_name: "bob" })],
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]!.accounts.map((a) => [a.kind, a.username])).toEqual([
      ["linked", "ada"],
      ["unverified", "ada.old"],
      ["pending", "ada.new"],
    ]);
    expect(groups[0]!.accounts[2]).toMatchObject({ requestedBy: "bob" });
  });

  it("lists every app, by name, with nothing in the ones not linked", () => {
    const groups = accountsByApp(
      [
        bridgeDetail({ bridge_id: "b2", display_name: "Zulu" }),
        bridgeDetail({ bridge_id: "b1", display_name: "Alpha" }),
      ],
      [linkedIdentity({ bridge_id: "b1" })],
      [],
    );

    expect(groups.map((g) => [g.app.display_name, g.accounts.length])).toEqual([
      ["Alpha", 1],
      ["Zulu", 0],
    ]);
  });
});

describe("afterClaim", () => {
  it("is done when the claim came back confirmed", () => {
    expect(afterClaim(claimed({ link_request: null }))).toEqual({ kind: "linked" });
  });

  it("waits on a code for a new link", () => {
    expect(afterClaim(claimed({ link_request: { user_id: "u-ada", code } }))).toEqual({
      kind: "confirm",
      target: { identityId: "acct-1", username: "ada", kind: "pending" },
      code,
    });
  });

  it("confirms an older link when the caller already holds one, so cancelling keeps it", () => {
    const next = afterClaim(
      claimed({
        claimed_by: [{ user_id: "u-ada", user_name: "ada", verified: false, can_unlink: true }],
        link_request: { user_id: "u-ada", code },
      }),
    );

    expect(next).toMatchObject({ kind: "confirm", target: { kind: "unverified" } });
  });
});

describe("commandsIn", () => {
  it("finds each command to post", () => {
    expect(
      commandsIn(
        "Run `/link-account code:ABCD-EFGH` from that account in a channel Switch is in, or post `!link-account ABCD-EFGH` there.",
      ),
    ).toEqual(["/link-account code:ABCD-EFGH", "!link-account ABCD-EFGH"]);
  });

  it("trusts no markup when the backticks do not pair up", () => {
    expect(commandsIn("Post `!link-account ABCD-EFGH from that account.")).toEqual([]);
  });
});

describe("codeDeadline", () => {
  it("counts the code's own lifetime from when it arrived, not the server's clock", () => {
    expect(codeDeadline(code, 1_000)).toBe(1_000 + 1_800_000);
  });
});

describe("looksCancelled", () => {
  const target = { identityId: "acct-1", username: "ada", kind: "pending" as const };

  it("is not judged on a pending list read before the screen opened", () => {
    expect(
      looksCancelled({ target, linked: [], pending: [], pendingReadAt: 5, openedAt: 10 }),
    ).toBe(false);
  });

  it("is when a pending link is in neither list after the screen opened", () => {
    expect(
      looksCancelled({ target, linked: [], pending: [], pendingReadAt: 10, openedAt: 10 }),
    ).toBe(true);
  });

  it("is not while the link is listed as linked or still waiting", () => {
    const args = { target, pendingReadAt: 10, openedAt: 10 };
    expect(
      looksCancelled({ ...args, linked: [linkedIdentity({ id: "acct-1" })], pending: [] }),
    ).toBe(false);
    expect(
      looksCancelled({ ...args, linked: [], pending: [pendingIdentity({ id: "acct-1" })] }),
    ).toBe(false);
  });

  it("is never for an older link, which the pending list leaves out", () => {
    expect(
      looksCancelled({
        target: { ...target, kind: "unverified" },
        linked: [],
        pending: [],
        pendingReadAt: 10,
        openedAt: 10,
      }),
    ).toBe(false);
  });
});

describe("what an app allows", () => {
  it("says why nothing can be done in an app that is not running", () => {
    expect(unavailableReason(bridgeDetail())).toBeNull();
    expect(unavailableReason(bridgeDetail({ status: "error", display_name: "Acme" }))).toMatch(
      /Acme isn't running/,
    );
  });

  it("says how to become findable only where there is no directory", () => {
    expect(findableNote(bridgeDetail())).toBeNull();
    expect(
      findableNote(bridgeDetail({ directory_search_supported: false, display_name: "Our Telegram" })),
    ).toMatch(/Send a message in a connected group first/);
  });
});
