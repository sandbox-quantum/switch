/**
 * What a connector's page says, decided here and only displayed by the page:
 * who the person is connected as, the way to connect from here, why the
 * connector is off in the workspace and who can change that, and the lines
 * its facts and lists read.
 */
import type { ConnectedPerson, ServiceConnection, ServiceGrant } from "../../data/api";

/** Connected in any state: a connection that needs a fresh sign-in is still theirs. */
export function isConnected(connection: Pick<ServiceConnection, "status">): boolean {
  return connection.status !== "not_connected";
}

/** "Connected as ada · Read and write"; null while not connected. */
export function connectedAsLine(
  connection: Pick<ServiceConnection, "status" | "auth_type" | "consent" | "external_identity">,
): string | null {
  if (!isConnected(connection)) return null;
  if (connection.auth_type === "api_key")
    return connection.external_identity
      ? `Connected with ${connection.external_identity}`
      : "Connected with your key";
  const who = connection.external_identity
    ? `Connected as ${connection.external_identity}`
    : "Connected";
  const access =
    connection.consent === "write" ? "Read and write" : connection.consent === "read" ? "Read" : null;
  return access ? `${who} · ${access}` : who;
}

/** How someone connects from this page: a key they paste here, or a sign-in
 * at the vendor, which finishes in Switch Console. Null where nothing can be
 * connected now: not built yet, off here, or with nothing to sign in
 * through; the page says why. */
export function connectWay(
  connection: Pick<ServiceConnection, "enabled" | "auth_type" | "workspace_enabled" | "connectable">,
): "key" | "console" | null {
  if (!connection.enabled || !connection.workspace_enabled || !connection.connectable) return null;
  return connection.auth_type === "api_key" ? "key" : "console";
}

export const CONSOLE_CONNECT_NOTE =
  "Signing in finishes in Switch Console on your computer: open its Connectors, and connect it there.";

/**
 * Why the connector is off in this workspace, and who can turn it back on;
 * null while it is on. The organization's lock is out of every workspace
 * admin's reach, and says so; anything else a workspace admin changes.
 */
export function offNotice(
  connection: Pick<ServiceConnection, "workspace_enabled" | "organization_locked" | "decided_by">,
  workspace: string,
): { text: string; fixedIn: "organization" | "workspace" } | null {
  if (connection.workspace_enabled) return null;
  const after = "Agents can't use it here until it is turned back on.";
  if (connection.organization_locked)
    return {
      text: `Switched off in ${workspace} by your organization, for every workspace. ${after} Only an organization admin can turn it back on.`,
      fixedIn: "organization",
    };
  const why =
    connection.decided_by === "organization"
      ? `Off in ${workspace} by your organization's default.`
      : connection.decided_by === "workspace"
        ? `Switched off in ${workspace} by a workspace admin.`
        : `Off in ${workspace}: connectors start off in a new workspace.`;
  return { text: `${why} ${after} A workspace admin can turn it on.`, fixedIn: "workspace" };
}

export function signInLabel(connection: Pick<ServiceConnection, "auth_type" | "slug" | "publisher" | "name">): string {
  if (connection.auth_type === "api_key") return "A key you paste";
  if (connection.slug === "github") return "Sign in with GitHub, through the Switch GitHub App";
  return `Sign in at ${connection.publisher ?? connection.name}`;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** How long what an agent is handed lasts. */
export function accessLastsLabel(
  connection: Pick<ServiceConnection, "auth_type" | "token_lifetime">,
): string {
  if (connection.auth_type === "api_key") return "The key itself, which doesn't expire";
  const seconds = connection.token_lifetime;
  if (seconds === null) return "Not stated";
  if (seconds < 3600) return plural(Math.round(seconds / 60), "minute");
  if (seconds < 86_400) return plural(Math.round(seconds / 3600), "hour");
  return plural(Math.round(seconds / 86_400), "day");
}

/** The level a grant gives, as its badge says it. A connector whose agents
 * use the owner's own token is on or off, at the connection's level. */
export function grantLabel(grant: Pick<ServiceGrant, "access">, passThrough: boolean): string {
  if (passThrough) return "On";
  return grant.access === "write" ? "Read and write" : "Read";
}

/** "Connected 2026-11-03 · 2 agents using it". */
export function personLine(person: ConnectedPerson, format: (iso: string) => string): string {
  const agents = person.agents === 1 ? "1 agent" : `${person.agents} agents`;
  return `Connected ${format(person.connected_at)} · ${agents} using it`;
}

export function revokeConfirmation(
  person: Pick<ConnectedPerson, "name" | "agents">,
  connector: string,
): { title: string; description: string } {
  const agents =
    person.agents === 0
      ? ""
      : ` ${person.agents === 1 ? "Their 1 agent loses" : `Their ${person.agents} agents lose`} ${connector}, and what was handed out to ${person.agents === 1 ? "it" : "them"} is revoked.`;
  return {
    title: `Revoke ${person.name}'s ${connector} access?`,
    description: `${person.name} is disconnected from ${connector} in this workspace.${agents} They can connect it again.`,
  };
}

/** Said of an agent others can address: whoever addresses it would have it
 * act as its owner, the viewer (null) or someone else, by name. */
export function openAgentNote(ownerName: string | null): string {
  return `Others can address it; it would act as ${ownerName ?? "you"}.`;
}
