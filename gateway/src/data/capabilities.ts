import type { CurrentTenant, Session } from "./api";
import {
  AGENT_MANAGEMENT,
  type FeatureFlagKey,
  type FeatureFlags,
  ORGANIZATION_CONNECTOR_APPS,
  SERVICE_CONNECTIONS,
} from "./featureFlags";

/** What the signed-in person may do across the dashboard, from the server's
 * own answers: the session, the current workspace and the deployment's
 * flags. This is the one place a role is read. Pages, the rail and the route
 * guards ask these, never the role; what someone may do to one object comes
 * from that object's own `can_*` flags. */
export interface Capabilities {
  isOperator: boolean;
  /** The server's `administers` for the current workspace: an admin
   * membership, `org_admin` of its organization, or the operator bit. */
  administersWorkspace: boolean;
  /** `org_admin` of the current workspace's organization. The operator is
   * not one by the operator bit alone. */
  administersOrganization: boolean;
  inOrganization: boolean;
  /** The current workspace's own `can_delete`: an admin membership of the
   * caller's, which the reach of an organization admin or the operator does
   * not count as, and never the server's default workspace. */
  canDeleteWorkspace: boolean;
  /** The current workspace's own `can_manage_data_protection`: setting a
   * retention window and erasing people's data, which take an admin
   * membership of the caller's, as deleting it does. */
  canManageDataProtection: boolean;
  features: FeatureFlags;
}

export function capabilitiesOf(
  session: Session | null,
  tenant: CurrentTenant | null,
  features: FeatureFlags,
): Capabilities {
  return {
    isOperator: session?.user.is_operator ?? false,
    administersWorkspace: tenant?.administers ?? false,
    administersOrganization: session?.tenant?.organization_role === "org_admin",
    inOrganization: (session?.tenant?.organization_id ?? null) !== null,
    canDeleteWorkspace: tenant?.can_delete ?? false,
    canManageDataProtection: tenant?.can_manage_data_protection ?? false,
    features,
  };
}

export type Access =
  | { allowed: true }
  | { allowed: false; reason: "not_permitted"; message: string }
  | { allowed: false; reason: "not_enabled"; flag: FeatureFlagKey; message: string };

/** Who may open a page, answered from capabilities alone. */
export type Rule = (caps: Capabilities) => Access;

const ALLOWED: Access = { allowed: true };

function notPermitted(message: string): Access {
  return { allowed: false, reason: "not_permitted", message };
}

export const everyone: Rule = () => ALLOWED;

export const workspaceAdmins: Rule = (caps) =>
  caps.administersWorkspace
    ? ALLOWED
    : notPermitted("Only this workspace's admins can open this page.");

export const operators: Rule = (caps) =>
  caps.isOperator ? ALLOWED : notPermitted("Only the platform operator can open this page.");

export const inOrganization: Rule = (caps) =>
  caps.inOrganization ? ALLOWED : notPermitted("This workspace belongs to no organization.");

const ONLY_ORGANIZATION_ADMINS = "Only the organization's admins can open this page.";

/** The organization's admins, and the operator, who may need to restore one. */
export const organizationAdmins: Rule = (caps) => {
  if (!caps.inOrganization) return inOrganization(caps);
  return caps.administersOrganization || caps.isOperator
    ? ALLOWED
    : notPermitted(ONLY_ORGANIZATION_ADMINS);
};

/** The organization's admins alone: the operator restores an admin, and
 * goes no further. */
export const organizationAdminsOnly: Rule = (caps) => {
  if (!caps.inOrganization) return inOrganization(caps);
  return caps.administersOrganization ? ALLOWED : notPermitted(ONLY_ORGANIZATION_ADMINS);
};

function feature(flag: FeatureFlagKey, what: string): Rule {
  return (caps) =>
    caps.features[flag]
      ? ALLOWED
      : { allowed: false, reason: "not_enabled", flag, message: `${what} turned on here.` };
}

export const agentManagement = feature(AGENT_MANAGEMENT, "Agent management isn't");
export const serviceConnections = feature(SERVICE_CONNECTIONS, "Connectors aren't");
export const organizationConnectorApps = feature(
  ORGANIZATION_CONNECTOR_APPS,
  "Organization connector apps aren't",
);

/** Allowed when every rule allows; otherwise the first refusal. */
export function allOf(...rules: Rule[]): Rule {
  return (caps) => {
    for (const rule of rules) {
      const access = rule(caps);
      if (!access.allowed) return access;
    }
    return ALLOWED;
  };
}
