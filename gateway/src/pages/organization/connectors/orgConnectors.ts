/**
 * What Organization settings › Connectors shows for each connector, decided
 * here and only displayed by the page: the organization's setting as one of
 * five, what its switch and menu change it to, and whether the connector can
 * be used at all before the organization sets up an app for it.
 */
import type {
  ConnectorApp,
  OrganizationService,
  OrganizationServiceSetting,
} from "../../../data/api";

/** An organization's say in a connector. The server keeps it as on or off,
 * locked or not, or none; these are the five that make. */
export type Policy =
  | "workspaces_decide"
  | "on_by_default"
  | "off_by_default"
  | "on_locked"
  | "off_locked";

export const POLICIES: readonly { value: Policy; label: string; detail: string }[] = [
  {
    value: "workspaces_decide",
    label: "Each workspace decides",
    detail: "Workspace admins turn it on or off for their own workspace.",
  },
  {
    value: "on_by_default",
    label: "On by default",
    detail: "On wherever a workspace admin hasn't chosen; they may turn it off.",
  },
  {
    value: "off_by_default",
    label: "Off by default",
    detail: "Off wherever a workspace admin hasn't chosen; they may turn it on.",
  },
  {
    value: "on_locked",
    label: "On in every workspace",
    detail: "Locked on: workspace admins can't turn it off.",
  },
  {
    value: "off_locked",
    label: "Off in every workspace",
    detail: "Locked off: it disappears from every workspace.",
  },
];

export function policyOf(setting: OrganizationServiceSetting | null): Policy {
  if (setting === null) return "workspaces_decide";
  if (setting.locked) return setting.enabled ? "on_locked" : "off_locked";
  return setting.enabled ? "on_by_default" : "off_by_default";
}

/** What the server is sent for `policy`; null gives up the organization's say. */
export function settingOf(policy: Policy): OrganizationServiceSetting | null {
  switch (policy) {
    case "workspaces_decide":
      return null;
    case "on_by_default":
      return { enabled: true, locked: false };
    case "off_by_default":
      return { enabled: false, locked: false };
    case "on_locked":
      return { enabled: true, locked: true };
    case "off_locked":
      return { enabled: false, locked: true };
  }
}

/** The card's switch: on while workspaces may use the connector at all. */
export function available(policy: Policy): boolean {
  return policy !== "off_locked";
}

/** Where the switch takes a connector: off is off everywhere and locked, and
 * on again hands the choice back to each workspace. */
export function policyForSwitch(on: boolean): Policy {
  return on ? "workspaces_decide" : "off_locked";
}

/** The chip beside the name, for a setting the switch alone doesn't say. */
export function policyChip(policy: Policy): string | null {
  switch (policy) {
    case "on_by_default":
      return "On by default";
    case "off_by_default":
      return "Off by default";
    case "on_locked":
      return "Locked on";
    case "workspaces_decide":
    case "off_locked":
      return null;
  }
}

/** Turning a connector off in every workspace takes it from people who use
 * it now, so it is confirmed first; nothing else here takes anything away
 * from more than the workspaces that already chose. */
export function needsConfirming(from: Policy, to: Policy): boolean {
  return to === "off_locked" && from !== "off_locked";
}

export function offConfirmation(
  service: Pick<OrganizationService, "name" | "connected_members">,
  workspaces: number,
): { title: string; description: string } {
  const where = workspaces === 1 ? "your workspace" : `all ${workspaces} workspaces`;
  const people =
    service.connected_members === 0
      ? ""
      : ` ${service.connected_members === 1 ? "The 1 person" : `The ${service.connected_members} people`} connected stay connected, and their agents' grants come back if you turn it on again.`;
  return {
    title: `Turn ${service.name} off in every workspace?`,
    description: `${service.name} disappears from ${where}, and workspace admins can't turn it back on. What was handed out to agents for it is revoked.${people}`,
  };
}

/** What stands between a connector and anyone using it in the organization,
 * and the way past it: its organization's app to set up, or fix, or a reason
 * nothing can be set up yet. Null when nothing does: the connector needs no
 * app of the organization's, has a working one, or goes through Switch's. */
export type SetupNeed =
  | { kind: "set_up" | "fix"; app: ConnectorApp }
  | { kind: "blocked"; reason: string }
  | null;

export function setupNeed(
  service: Pick<OrganizationService, "server_switched_off">,
  app: ConnectorApp | undefined,
): SetupNeed {
  // Off for everyone already; the card says why, and an app would not help.
  if (service.server_switched_off !== null || app === undefined) return null;
  if (app.source === "saved") return null;
  // Saved but unusable: it is the one the workspaces go through, so Switch's
  // app does not stand in for it.
  const saved = app.saved_client_id !== null;
  if (!saved && app.server_app === true) return null;
  if (app.setup_blocked !== null) return { kind: "blocked", reason: app.setup_blocked };
  return { kind: saved ? "fix" : "set_up", app };
}

export const SETUP_LABEL: Record<"set_up" | "fix", string> = {
  set_up: "Set up org account",
  fix: "Fix org account",
};

/** The status an app's row wears, beside its name. */
export function appRowStatus(
  app: ConnectorApp,
  state: "ready" | "not_set_up" | "configured" | "attention",
): string {
  if (state === "not_set_up" && app.server_app === true) return "Using Switch's app";
  switch (state) {
    case "ready":
      return "Set up";
    case "not_set_up":
      return "Not set up";
    case "configured":
      return "Set in configuration";
    case "attention":
      return "Needs attention";
  }
}
