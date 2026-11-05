import { describe, expect, it } from "vitest";
import type { CloudLogin } from "../../../data/cloudLogins";
import type { ManagedAgent } from "../../../data/management";
import { deletePlan } from "./cloudDelete";

const agent = (id: string, provider: string, over: Partial<ManagedAgent> = {}) =>
  ({
    agent_id: id,
    name: id,
    display_name: null,
    controller_id: "box-ctl",
    definition: { provider },
    ...over,
  }) as unknown as ManagedAgent;

const login = (provider: string): CloudLogin => ({ provider, revision: 1, key_id: "k", updated_at: "2026-11-05T00:00:00Z" });

describe("deleting a cloud agent and its box's login", () => {
  it("withdraws the login first when it's the last agent on the box using it", () => {
    expect(deletePlan("a1", "box-ctl", [agent("a1", "claude"), agent("a2", "codex")], [login("claude")])).toEqual({
      kind: "withdraw_then_delete",
      provider: "claude",
    });
  });

  it("keeps the login and names the agents still using it, by display name", () => {
    const agents = [
      agent("a1", "claude"),
      agent("a2", "claude", { display_name: "Web front end" }),
      agent("a3", "claude", { name: "docs-writer" }),
    ];
    expect(deletePlan("a1", "box-ctl", agents, [login("claude")])).toEqual({
      kind: "delete_keep_login",
      provider: "claude",
      sharedWith: ["docs-writer", "Web front end"],
    });
  });

  it("counts only agents on the same box", () => {
    const agents = [agent("a1", "claude"), agent("mac-agent", "claude", { controller_id: "my-mac" })];
    expect(deletePlan("a1", "box-ctl", agents, [login("claude")]).kind).toBe("withdraw_then_delete");
  });

  it("has nothing to withdraw when the box holds no login for its provider", () => {
    expect(deletePlan("a1", "box-ctl", [agent("a1", "claude")], [login("codex")])).toEqual({ kind: "delete_only" });
  });

  it("says when the agent is gone", () => {
    expect(deletePlan("gone", "box-ctl", [agent("a1", "claude")], [login("claude")])).toEqual({ kind: "not_found" });
  });
});
