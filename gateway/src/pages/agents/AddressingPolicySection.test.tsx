import { describe, expect, it } from "vitest";
import { ruleIsDead, type RuleState } from "./AddressingPolicySection";

function rule(overrides: Partial<RuleState>): RuleState {
  return {
    rooms: { mode: "any", ids: [] },
    room_groups: { mode: "any", ids: [] },
    users: { mode: "any", ids: [] },
    agents: { mode: "any", ids: [] },
    platform: false,
    ...overrides,
  };
}

describe("ruleIsDead", () => {
  it("reports a rule with empty rooms dimension as dead", () => {
    expect(ruleIsDead(rule({ rooms: { mode: "specific", ids: [] } }))).toBe(true);
  });

  it("reports a rule with empty room_groups dimension as dead", () => {
    expect(ruleIsDead(rule({ room_groups: { mode: "specific", ids: [] } }))).toBe(true);
  });

  it("reports a rule with both sender dimensions set to none as dead", () => {
    expect(
      ruleIsDead(
        rule({
          users: { mode: "none", ids: [] },
          agents: { mode: "none", ids: [] },
        }),
      ),
    ).toBe(true);
  });

  it("reports a rule with both sender dimensions empty and specific as dead", () => {
    expect(
      ruleIsDead(
        rule({
          users: { mode: "specific", ids: [] },
          agents: { mode: "specific", ids: [] },
        }),
      ),
    ).toBe(true);
  });

  it("does NOT report a rule with owner=true as dead, even with empty sender dimensions", () => {
    expect(
      ruleIsDead(
        rule({
          users: { mode: "none", ids: [] },
          agents: { mode: "none", ids: [] },
          owner: true,
        }),
      ),
    ).toBe(false);
  });

  it("does NOT report a rule with owner_agents=true as dead, even with empty sender dimensions", () => {
    expect(
      ruleIsDead(
        rule({
          users: { mode: "none", ids: [] },
          agents: { mode: "none", ids: [] },
          owner_agents: true,
        }),
      ),
    ).toBe(false);
  });

  it("does NOT report a rule with platform=true as dead, even with empty sender dimensions", () => {
    expect(
      ruleIsDead(
        rule({
          users: { mode: "none", ids: [] },
          agents: { mode: "none", ids: [] },
          platform: true,
        }),
      ),
    ).toBe(false);
  });

  it("does NOT report a rule with owner=true and owner_agents=true as dead", () => {
    expect(
      ruleIsDead(
        rule({
          users: { mode: "specific", ids: [] },
          agents: { mode: "specific", ids: [] },
          owner: true,
          owner_agents: true,
        }),
      ),
    ).toBe(false);
  });

  it("reports a rule as alive when context dimensions are open and at least one sender dimension has ids", () => {
    expect(
      ruleIsDead(
        rule({
          users: { mode: "specific", ids: ["user-1"] },
          agents: { mode: "none", ids: [] },
        }),
      ),
    ).toBe(false);
  });

  it("reports a rule as alive when all dimensions are any", () => {
    expect(ruleIsDead(rule({}))).toBe(false);
  });
});
