import { describe, expect, it } from "vitest";
import { serviceStanding, serviceSwitchNote, switchOffConfirmation } from "./serviceCopy";

describe("serviceStanding", () => {
  it("says nobody has connected a service no one uses", () => {
    expect(serviceStanding({ connected_members: 0, granted_agents: 0 })).toBe(
      "Nobody has connected it yet",
    );
  });

  it("counts members and agents, singular and plural", () => {
    expect(serviceStanding({ connected_members: 1, granted_agents: 2 })).toBe(
      "1 member connected · 2 agents use it",
    );
  });
});

describe("switchOffConfirmation", () => {
  it("asks nothing for a service that reaches nobody", () => {
    expect(
      switchOffConfirmation({ name: "GitHub", connected_members: 0, granted_agents: 0 }),
    ).toBeNull();
  });

  it("names both counts when it reaches someone", () => {
    expect(
      switchOffConfirmation({ name: "GitHub", connected_members: 2, granted_agents: 1 }),
    ).toEqual({
      title: "Switch GitHub off for this workspace?",
      description:
        "2 members are connected and 1 agent uses it. Their sessions lose it within a minute. Their grants are kept, so switching it back on returns them.",
    });
  });
});

describe("serviceSwitchNote", () => {
  const day = (iso: string) => iso.slice(0, 10);

  it("gives the default for a switch nobody touched", () => {
    expect(
      serviceSwitchNote({ enabled: false, updated_by_name: null, updated_at: null }, day),
    ).toBe("Off by default.");
  });

  it("names who switched it, and when", () => {
    expect(
      serviceSwitchNote(
        { enabled: true, updated_by_name: "Ada", updated_at: "2026-10-01T12:00:00Z" },
        day,
      ),
    ).toBe("Switched on by Ada, 2026-10-01.");
  });

  it("says so when the account that switched it is gone", () => {
    expect(
      serviceSwitchNote(
        { enabled: false, updated_by_name: null, updated_at: "2026-10-01T12:00:00Z" },
        day,
      ),
    ).toBe("Switched off by a deleted account, 2026-10-01.");
  });
});
