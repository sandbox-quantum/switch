import { describe, expect, it } from "vitest";
import type { Member } from "../data/api";
import { transferCandidates } from "./TransferOwnershipSection";

const member = (user_id: string, can_receive_transfer = true): Member =>
  ({ user_id, can_receive_transfer }) as Member;

describe("transferCandidates", () => {
  it("offers whoever the server says may receive it, but its owner", () => {
    const members = [
      member("owner"),
      member("caller", false),
      member("org-admin-through-the-organization", false),
      member("other"),
    ];
    expect(transferCandidates(members, "owner").map((m) => m.user_id)).toEqual(["other"]);
  });
});
