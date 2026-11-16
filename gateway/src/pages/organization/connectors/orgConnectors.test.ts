import { describe, expect, it } from "vitest";
import { app } from "../../connector-apps/testFixtures";
import {
  POLICIES,
  type Policy,
  appRowStatus,
  available,
  needsConfirming,
  offConfirmation,
  policyChip,
  policyForSwitch,
  policyOf,
  settingOf,
  setupNeed,
} from "./orgConnectors";

const ON = { server_switched_off: null };

describe("the organization's setting", () => {
  it.each(POLICIES.map((p) => p.value))("%s is what the server is sent, and read back", (policy) => {
    expect(policyOf(settingOf(policy))).toBe(policy);
  });

  it("is each workspace's own choice while the organization set nothing", () => {
    expect(policyOf(null)).toBe("workspaces_decide");
    expect(settingOf("workspaces_decide")).toBeNull();
  });

  it("is off on the switch only where it is off and locked", () => {
    const off = POLICIES.map((p) => p.value).filter((policy) => !available(policy));
    expect(off).toEqual(["off_locked"]);
  });

  it("switches off to off and locked, and back on to each workspace deciding", () => {
    expect(policyForSwitch(false)).toBe("off_locked");
    expect(policyForSwitch(true)).toBe("workspaces_decide");
  });

  it("names on the card what the switch alone does not say", () => {
    const chips = Object.fromEntries(
      POLICIES.map((p) => [p.value, policyChip(p.value)]),
    ) as Record<Policy, string | null>;
    expect(chips).toEqual({
      workspaces_decide: null,
      on_by_default: "On by default",
      off_by_default: "Off by default",
      on_locked: "Locked on",
      off_locked: null,
    });
  });

  it("asks first only when it turns a connector off everywhere", () => {
    expect(needsConfirming("workspaces_decide", "off_locked")).toBe(true);
    expect(needsConfirming("on_locked", "off_locked")).toBe(true);
    expect(needsConfirming("off_locked", "off_locked")).toBe(false);
    expect(needsConfirming("on_locked", "off_by_default")).toBe(false);
  });

  it("says what turning it off everywhere does, and keeps", () => {
    expect(offConfirmation({ name: "GitHub", connected_members: 4 }, 3)).toEqual({
      title: "Turn GitHub off in every workspace?",
      description:
        "GitHub disappears from all 3 workspaces, and workspace admins can't turn it back on. What was handed out to agents for it is revoked. The 4 people connected stay connected, and their agents' grants come back if you turn it on again.",
    });
    expect(offConfirmation({ name: "GitHub", connected_members: 0 }, 1).description).toBe(
      "GitHub disappears from your workspace, and workspace admins can't turn it back on. What was handed out to agents for it is revoked.",
    );
  });
});

describe("what stands before anyone can use a connector", () => {
  it("is nothing for a connector that needs no app of the organization's", () => {
    expect(setupNeed(ON, undefined)).toBeNull();
  });

  it("is nothing once the organization's own app works", () => {
    expect(setupNeed(ON, app({ source: "saved" }))).toBeNull();
  });

  it("is nothing while Switch's app serves the organization's workspaces", () => {
    expect(
      setupNeed(ON, app({ source: "none", saved_client_id: null, server_app: true })),
    ).toBeNull();
  });

  it("is the organization's app to set up when neither it nor Switch has one", () => {
    const missing = app({ source: "none", saved_client_id: null, server_app: false });
    expect(setupNeed(ON, missing)).toEqual({ kind: "set_up", app: missing });
  });

  it("is the organization's app to fix when it is saved but unusable, Switch's or not", () => {
    const broken = app({ source: "none", load_error: "Bad key.", server_app: true });
    expect(setupNeed(ON, broken)).toEqual({ kind: "fix", app: broken });
  });

  it("is the reason when it can't be set up yet", () => {
    expect(
      setupNeed(
        ON,
        app({ source: "none", saved_client_id: null, server_app: false, setup_blocked: "Needs https." }),
      ),
    ).toEqual({ kind: "blocked", reason: "Needs https." });
  });

  it("is nothing for a connector off for everyone, which an app would not change", () => {
    expect(
      setupNeed(
        { server_switched_off: "Off here." },
        app({ source: "none", saved_client_id: null, server_app: false }),
      ),
    ).toBeNull();
  });
});

describe("an app's row", () => {
  it("says the workspaces use Switch's app while the organization has none", () => {
    expect(appRowStatus(app({ server_app: true }), "not_set_up")).toBe("Using Switch's app");
    expect(appRowStatus(app({ server_app: false }), "not_set_up")).toBe("Not set up");
    expect(appRowStatus(app(), "ready")).toBe("Set up");
  });
});
