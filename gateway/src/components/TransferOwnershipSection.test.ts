import { describe, expect, it } from "vitest";
import type { Member } from "../data/api";
import { transferCandidates } from "./TransferOwnershipSection";

const member = (user_id: string): Member => ({ user_id }) as Member;

describe("transferCandidates", () => {
  const members = [member("owner"), member("admin"), member("other")];

  it("leaves out the owner when the owner transfers", () => {
    expect(transferCandidates(members, "owner", "owner").map((m) => m.user_id)).toEqual([
      "admin",
      "other",
    ]);
  });

  it("leaves out an admin transferring someone else's thing", () => {
    expect(transferCandidates(members, "owner", "admin").map((m) => m.user_id)).toEqual(["other"]);
  });
});
