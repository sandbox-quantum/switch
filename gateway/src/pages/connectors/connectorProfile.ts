/**
 * What a connector's page says, decided here and only displayed by the page:
 * who the person is connected as, the way to connect from here, why the
 * connector is off in the workspace and who can change that, and the lines
 * its facts and lists read.
 */
import type {
  ConnectedPerson,
  ServiceConnection,
  ServiceGrant,
  ServicePasteMethod,
  SignInOutcome,
} from "../../data/api";
import { githubThroughApp } from "../../data/api";

/** Connected in any state: a connection that needs a fresh sign-in is still theirs. */
export function isConnected(connection: Pick<ServiceConnection, "status">): boolean {
  return connection.status !== "not_connected";
}

/** "Connected as ada · Read and write", or what a pasted token reaches in
 * place of the level; null while not connected. */
export function connectedAsLine(
  connection: Pick<ServiceConnection, "status" | "auth_type" | "consent" | "external_identity" | "access_note">,
): string | null {
  if (!isConnected(connection)) return null;
  if (connection.auth_type === "api_key")
    return connection.external_identity
      ? `Connected with ${connection.external_identity}`
      : "Connected with your key";
  const who = connection.external_identity
    ? `Connected as ${connection.external_identity}`
    : "Connected";
  if (connection.access_note) return `${who} · ${connection.access_note}`;
  const access =
    connection.consent === "write" ? "Read and write" : connection.consent === "read" ? "Read" : null;
  return access ? `${who} · ${access}` : who;
}

export type ConnectWay = "key" | "web" | "paste" | "console";

/** How someone connects from here: a key they paste, a sign-in at the
 * vendor that comes back to this page, a token pasted in place of a sign-in
 * that can only come back to Switch Console, or that sign-in alone. Null
 * where nothing can be connected now: not built yet, off here, or with
 * nothing to sign in through; the page says why. */
export function connectWay(
  connection: Pick<
    ServiceConnection,
    "enabled" | "auth_type" | "workspace_enabled" | "connectable" | "web_sign_in" | "paste"
  >,
): ConnectWay | null {
  if (!connection.enabled || !connection.workspace_enabled || !connection.connectable) return null;
  if (connection.auth_type === "api_key") return "key";
  if (connection.web_sign_in) return "web";
  return connection.paste.length > 0 ? "paste" : "console";
}

/** Whether the connection was made by pasting a token or keys. */
export function isPasted(connection: Pick<ServiceConnection, "method">): boolean {
  return connection.method === "token" || connection.method === "keys";
}

/** How long a pasted credential lasts, as its dialog and page say it. */
export function pastedLasts(name: string, expires: ServicePasteMethod["expires"]): string {
  return expires === "vendor" ? `Expires on the date you set in ${name}.` : `Never expires; only ${name} can revoke it.`;
}

const PERMISSION_NAMES: Record<string, string> = {
  contents: "Code",
  pull_requests: "Pull requests",
  issues: "Issues",
  workflows: "Workflows",
};

/** What a vendor's prefilled form for a new token asks for, read off its
 * link: each permission and level, then how long it lasts. */
export function prefilledAccess(createUrl: string): string[] {
  const params = new URL(createUrl).searchParams;
  const said: string[] = [];
  params.forEach((level, key) => {
    if (["name", "description", "target_name", "expires_in"].includes(key)) return;
    const name = PERMISSION_NAMES[key] ?? key.replaceAll("_", " ");
    said.push(`${name}: ${level === "write" ? "read and write" : level}`);
  });
  const days = params.get("expires_in");
  if (days && days !== "none") said.push(`Expires in ${days} days`);
  return said;
}

/** How each way of connecting a service differs, where the page sets them
 * side by side: by the service's slug. */
export interface ConnectChoice {
  title: string;
  points: string[];
}

export const CONNECT_CHOICES: Record<string, { signIn: ConnectChoice; token: ConnectChoice }> = {
  github: {
    signIn: {
      title: "Switch GitHub App",
      points: [
        "You pick the repositories each agent can use",
        "Agents act as the Switch app, not as you",
        "Access lasts an hour at a time, and Switch can revoke it",
      ],
    },
    token: {
      title: "Personal access token",
      points: [
        "For when the App isn't installed in your organization",
        "Agents act as you, wherever the token reaches",
        "It ends on the date you set; only GitHub can revoke it",
      ],
    },
  },
};

export const CONSOLE_SIGN_IN_NOTE =
  "To sign in with your account instead, connect it from Switch Console on your computer.";

export const CONSOLE_CONNECT_NOTE =
  "Its sign-in can only finish in Switch Console on your computer: open its Connectors, and connect it there.";

/** Said under "Connected as" when the connection no longer works; null while it does. */
export function brokenLine(
  connection: Pick<ServiceConnection, "status" | "auth_type" | "web_sign_in" | "method" | "reconnect_reason">,
): string | null {
  if (connection.status === "active" || connection.status === "not_connected") return null;
  if (connection.auth_type === "api_key") return "Its key needs replacing before agents can use it again.";
  if (isPasted(connection))
    return (
      connection.reconnect_reason ??
      (connection.method === "token"
        ? "Its token needs replacing before agents can use it again."
        : "Its keys need replacing before agents can use them again.")
    );
  return connection.web_sign_in
    ? "It needs a fresh sign-in before agents can use it again."
    : "It needs a fresh sign-in, from Switch Console, before agents can use it again.";
}

/** What the connector's page says when the browser comes back from a
 * sign-in it started: a success toast, a notice to keep, or why it failed. */
export function signInOutcomeMessage(
  outcome: SignInOutcome,
  connector: string,
): { toast: string | null; error: string | null } {
  if (outcome.status === "connected")
    return {
      toast: outcome.account ? `Connected to ${connector} as ${outcome.account}.` : `${connector} is connected.`,
      error: null,
    };
  if (outcome.status === "failed")
    return { toast: null, error: outcome.error ?? `${connector} sign-in failed. Connect again.` };
  return { toast: null, error: `The ${connector} sign-in didn't finish. Connect again.` };
}

/** "Project management · 3 people connected": the category, and for a
 * workspace admin how many people here have connected it. */
export function catalogueMeta(
  connection: Pick<ServiceConnection, "category">,
  peopleConnected: number | null,
): string {
  if (peopleConnected === null) return connection.category;
  const people = peopleConnected === 1 ? "1 person" : `${peopleConnected} people`;
  return `${connection.category} · ${people} connected`;
}

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
    connection.decided_by === "organization_default"
      ? `Off in ${workspace} by your organization's default.`
      : connection.decided_by === "workspace"
        ? `Switched off in ${workspace} by a workspace admin.`
        : `Off in ${workspace}: connectors start off in a new workspace.`;
  return { text: `${why} ${after} A workspace admin can turn it on.`, fixedIn: "workspace" };
}

export function signInLabel(
  connection: Pick<
    ServiceConnection,
    | "auth_type"
    | "slug"
    | "publisher"
    | "name"
    | "pass_through"
    | "method"
    | "status"
    | "paste"
    | "sign_in_unavailable_reason"
  >,
): string {
  if (connection.auth_type === "api_key") return "A key you paste";
  if (connection.method === "token") return "A token you pasted";
  if (connection.method === "keys") return "Keys you pasted";
  if (githubThroughApp(connection))
    return connection.sign_in_unavailable_reason !== null
      ? "A personal access token (the Switch GitHub App isn't set up here)"
      : connection.status !== "active" && connection.paste.some((way) => way.method === "token")
      ? "The Switch GitHub App, or a personal access token"
      : "Sign in with GitHub, through the Switch GitHub App";
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
