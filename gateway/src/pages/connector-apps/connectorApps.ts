/**
 * What the Connectors page shows, decided here and only displayed by the
 * components: each card's state, the one sentence and button that go with
 * it, the order, which actions it offers, and the wording of every dialog.
 * Labels follow what Google and GitHub call things, so the operator can copy
 * values across.
 */
import type { ConnectorApp, ConnectorAppField, ConnectorAppImpact } from "../../data/api";

export type CardState = "ready" | "not_set_up" | "configured" | "attention";

export type AttentionCause =
  | "setup_blocked"
  | "check_failed"
  | "unreadable"
  | "load_error"
  | "saved_ignored"
  | "stale";

export type CardAction = "set_up" | "manage_here" | "check" | "update_secret" | "enter_again";

export interface Attention {
  cause: AttentionCause;
  sentence: string;
  /** The one fix offered beside the sentence; null where there is nothing to press. */
  action: CardAction | null;
}

export type MenuAction = "update_secret" | "switch_app" | "remove";

export type Audience = "internal" | "external";

export interface Instruction {
  text: string;
  /** Values to paste at the vendor, each offered with a copy button. */
  copy: string[];
  /** The vendor's page for this step, where it has one of its own. */
  link: { label: string; href: string } | null;
  /** Values to pick at the vendor, one per line. */
  items: string[];
}

export interface SecretField {
  name: Exclude<ConnectorAppField, "client_id">;
  label: string;
  /** A file the browser reads (the .pem), never shown. */
  file: boolean;
}

const GOOGLE = "google-workspace";
const AIRTABLE = "airtable";

export function vendorName(app: Pick<ConnectorApp, "slug" | "kind" | "name">): string {
  if (app.kind === "github_app") return "GitHub";
  if (app.slug === GOOGLE) return "Google";
  return app.name;
}

/** "12 people in 3 workspaces", "1 person in 1 workspace". */
export function peopleIn(usage: ConnectorAppImpact): string {
  const people = usage.connected_members === 1 ? "1 person" : `${usage.connected_members} people`;
  const workspaces = usage.workspaces === 1 ? "1 workspace" : `${usage.workspaces} workspaces`;
  return `${people} in ${workspaces}`;
}

function variables(app: ConnectorApp): string {
  return app.configuration_variables.join(" and ");
}

/** Copied into Switch, and waiting for the configuration to be removed. */
export function waitingForRestart(app: ConnectorApp): boolean {
  return (
    app.source === "configuration" &&
    app.saved_ignored &&
    app.saved_client_id !== null &&
    app.saved_client_id === app.client_id
  );
}

/** What needs the operator, most pressing first; null when nothing does. */
export function attention(app: ConnectorApp, checkFailure: string | null): Attention | null {
  // A configured app keeps working: only setting one up here is blocked.
  if (app.setup_blocked !== null && app.source !== "configuration")
    return { cause: "setup_blocked", sentence: app.setup_blocked, action: "set_up" };
  if (checkFailure !== null)
    return { cause: "check_failed", sentence: checkFailure, action: "update_secret" };
  if (app.unreadable)
    return {
      cause: "unreadable",
      sentence: "Switch can't read the saved secret any more.",
      action: "enter_again",
    };
  if (app.load_error !== null)
    return { cause: "load_error", sentence: app.load_error, action: "enter_again" };
  if (app.saved_ignored && !waitingForRestart(app))
    return {
      cause: "saved_ignored",
      sentence: `Saved here, but ${variables(app)} is still set, so Switch uses that. Remove it and restart Switch.`,
      action: "manage_here",
    };
  if (app.stale_connections > 0)
    return {
      cause: "stale",
      sentence:
        app.stale_connections === 1
          ? "1 person still needs to reconnect."
          : `${app.stale_connections} people still need to reconnect.`,
      action: null,
    };
  return null;
}

export function cardState(app: ConnectorApp, checkFailure: string | null): CardState {
  if (attention(app, checkFailure) !== null) return "attention";
  if (app.source === "configuration") return "configured";
  if (app.source === "saved") return "ready";
  return "not_set_up";
}

export function stateLabel(state: CardState): string {
  switch (state) {
    case "ready":
      return "Ready";
    case "not_set_up":
      return "Not set up";
    case "configured":
      return "Set on the server";
    case "attention":
      return "Needs attention";
  }
}

const ORDER: Record<CardState, number> = {
  attention: 0,
  not_set_up: 1,
  configured: 2,
  ready: 3,
};

/** Cards that need attention first, then not set up, then working. */
export function cardOrder(
  apps: ConnectorApp[],
  checkFailures: Record<string, string>,
): ConnectorApp[] {
  return [...apps].sort(
    (a, b) =>
      ORDER[cardState(a, checkFailures[a.slug] ?? null)] -
        ORDER[cardState(b, checkFailures[b.slug] ?? null)] || a.name.localeCompare(b.name),
  );
}

export function notSetUpSentence(app: ConnectorApp): string {
  return app.kind === "github_app"
    ? "People can't connect GitHub until you add Switch's GitHub App."
    : `People can't connect ${app.name} until you add Switch's ${vendorName(app)} client.`;
}

/** The card's one obvious button. */
export function primaryAction(app: ConnectorApp, checkFailure: string | null): CardAction | null {
  const state = cardState(app, checkFailure);
  if (state === "not_set_up") return "set_up";
  if (state === "attention") {
    const fix = attention(app, checkFailure)?.action ?? null;
    return fix ?? (app.source === "none" ? null : "check");
  }
  if (state === "configured") return app.deprecated || waitingForRestart(app) ? null : "manage_here";
  return "check";
}

export function actionLabel(app: ConnectorApp, action: CardAction): string {
  switch (action) {
    case "set_up":
      return `Set up ${app.kind === "github_app" ? "GitHub" : app.name}`;
    case "manage_here":
      return "Manage it here instead";
    case "check":
      return "Check it works";
    case "update_secret":
      return "Update secret";
    case "enter_again":
      return "Enter it again";
  }
}

/** The ⋯ menu: changes split by what they do to the people connected. */
export function menuActions(app: ConnectorApp): MenuAction[] {
  if (app.source === "saved") return ["update_secret", "switch_app", "remove"];
  // Saved, but unusable: it can be entered again, or removed.
  if (app.source === "none" && app.saved_client_id !== null) return ["remove"];
  return [];
}

export function menuLabel(app: ConnectorApp, action: MenuAction): string {
  switch (action) {
    case "update_secret":
      return app.kind === "github_app" ? "Update secret or private key" : "Update secret";
    case "switch_app":
      return "Use a different app";
    case "remove":
      return "Remove";
  }
}

export function configuredSentence(app: ConnectorApp): string {
  if (app.deprecated)
    return "Using HOSTED_GITHUB_CONFIG_PATH, which names no private key, so GitHub can be connected but not granted. Set up the GitHub App here instead, after unsetting it.";
  const one = app.configuration_variables.length === 1;
  const from = `From ${variables(app)}. Change ${one ? "it" : "them"} there, or remove ${one ? "it" : "them"} to manage it here.`;
  if (waitingForRestart(app))
    return `${from} A copy is saved here, same client. Remove the ${one ? "variable" : "variables"} and restart Switch to use the copy.`;
  return from;
}

export function secretFields(app: Pick<ConnectorApp, "kind">): SecretField[] {
  const secret: SecretField = { name: "client_secret", label: "Client secret", file: false };
  return app.kind === "github_app"
    ? [secret, { name: "private_key", label: "Private key", file: true }]
    : [secret];
}

/** "ends in ab12", or a key's fingerprint. */
export function secretSummary(app: ConnectorApp): string | null {
  const secret = app.secrets.client_secret;
  const parts = [];
  if (secret?.set) parts.push(secret.last4 ? `Secret ends in ${secret.last4}` : "Secret set");
  const key = app.secrets.private_key;
  if (key?.set) parts.push(key.fingerprint ? `Key ${key.fingerprint}` : "Key set");
  return parts.length ? parts.join(" · ") : null;
}

export function usedBy(app: ConnectorApp): string {
  return `Used by ${peopleIn(app)}`;
}

/** "Contents", "Contents and Pull requests", "A, B and C". */
function joined(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** What a GitHub App short of the write permissions means; null for any other app. */
export function readOnlySentence(app: Pick<ConnectorApp, "read_only" | "lacks_write">): string | null {
  if (!app.read_only) return null;
  return `Agents can read only: the App lacks ${joined(app.lacks_write)} write. Write grants are refused.`;
}

/** Google's choice of who may connect; it changes only the instructions. */
export function asksWhoConnects(app: Pick<ConnectorApp, "slug">): boolean {
  return app.slug === GOOGLE;
}

export function audienceText(audience: Audience): string {
  return audience === "internal"
    ? "Under Audience, choose Internal. Only people in your Google organization can connect, and Google doesn't need to review the app."
    : "Under Audience, choose External, and add the people who will try it as test users. Until Google verifies the app, only test users can connect, and they must reconnect every 7 days. Because Switch reads Drive, Google's review includes a security assessment renewed every year.";
}

const GOOGLE_CLOUD = "https://console.cloud.google.com";

/** The addresses to register, in one step: a vendor that matches the port needs every one. */
function redirectStep(intro: string, redirects: string[]): Instruction {
  return { text: intro, copy: redirects, link: null, items: [] };
}

/** Scopes one row per resource, its read and write side by side. */
function scopeRows(scopes: string[]): string[] {
  const rows = new Map<string, string[]>();
  for (const scope of scopes) {
    const resource = scope.slice(0, scope.lastIndexOf(":"));
    rows.set(resource, [...(rows.get(resource) ?? []), scope]);
  }
  return [...rows.values()].map((row) => row.join(", "));
}

function present(value: string | null): string[] {
  return value === null ? [] : [value];
}

/** Step 1 of setting up: creating the app at the vendor, one page at a time. */
export function setupInstructions(
  app: ConnectorApp,
  audience: Audience,
  publicUrl: string | null,
): Instruction[] {
  const redirect = app.redirect_uri;
  if (app.kind === "github_app")
    return [
      {
        text: "In GitHub, create a new GitHub App: Settings, Developer settings, GitHub Apps. For an App owned by an organization, start from the organization's settings instead.",
        copy: [],
        link: { label: "Open GitHub", href: "https://github.com/settings/apps/new" },
        items: [],
      },
      { text: "Set the Homepage URL to Switch's public URL:", copy: present(publicUrl), link: null, items: [] },
      { text: "Set the Callback URL to:", copy: present(redirect), link: null, items: [] },
      { text: "Keep Expire user authorization tokens turned on.", copy: [], link: null, items: [] },
      {
        text: "Under Webhook, untick Active. Switch doesn't use GitHub's webhooks, and GitHub asks for a webhook URL while it is ticked.",
        copy: [],
        link: null,
        items: [],
      },
      {
        text: "Under Repository permissions, set Contents and Pull requests to Read and write.",
        copy: [],
        link: null,
        items: [],
      },
      {
        text: "Under Where can this GitHub App be installed, choose Any account, so people can install it on their own accounts and organizations. Choose Only on this account only if every member's repositories are in your own organization.",
        copy: [],
        link: null,
        items: [],
      },
      {
        text: "Create the GitHub App. On its page, generate a client secret, then a private key, and keep the downloaded .pem file.",
        copy: [],
        link: null,
        items: [],
      },
    ];
  if (app.slug === AIRTABLE)
    return [
      {
        text: "In Airtable's Builder Hub, under OAuth integrations, register a new OAuth integration. Use an Airtable account your organization owns: whoever owns the integration can delete it, and that stops every connection.",
        copy: [],
        link: { label: "Open Builder Hub", href: "https://airtable.com/create/oauth" },
        items: [],
      },
      {
        text: "Name it as people should see it on Airtable's consent page, for example Switch.",
        copy: [],
        link: null,
        items: [],
      },
      redirectStep(
        "Under OAuth redirect URLs, add this one:",
        app.redirect_uris,
      ),
      {
        text: "Under Scopes, tick exactly these:",
        copy: [],
        link: null,
        items: scopeRows(app.scopes),
      },
      {
        text: "Register the integration. On its page, generate a client secret, and copy the Client ID and the secret.",
        copy: [],
        link: null,
        items: [],
      },
      {
        text: "Fill in its support email, privacy policy URL and terms of service URL. Until all three are set, Airtable lets only the owner connect.",
        copy: [],
        link: null,
        items: [],
      },
    ];
  if (app.slug === GOOGLE)
    return [
      {
        text: "In Google Cloud, create a project for Switch, or pick an existing one.",
        copy: [],
        link: { label: "Create a project", href: `${GOOGLE_CLOUD}/projectcreate` },
        items: [],
      },
      {
        text: "In Google Auth Platform, under Branding, enter an app name people will recognise and a support email.",
        copy: [],
        link: { label: "Open Branding", href: `${GOOGLE_CLOUD}/auth/branding` },
        items: [],
      },
      {
        text: audienceText(audience),
        copy: [],
        link: { label: "Open Audience", href: `${GOOGLE_CLOUD}/auth/audience` },
        items: [],
      },
      {
        text: "Under Clients, create a client of type Web application.",
        copy: [],
        link: { label: "Open Clients", href: `${GOOGLE_CLOUD}/auth/clients` },
        items: [],
      },
      {
        text: "Add this under Authorized redirect URIs, create the client, and copy its Client ID and Client secret:",
        copy: present(redirect),
        link: null,
        items: [],
      },
      {
        text: "Enable the Google Drive, Docs, Sheets, Slides and Calendar APIs for the project.",
        copy: [],
        link: { label: "Open the API Library", href: `${GOOGLE_CLOUD}/apis/library` },
        items: [],
      },
    ];
  return [
    redirectStep(
      `Register an OAuth client for Switch at ${app.name}, with ${app.redirect_uris.length > 1 ? "these redirect URIs" : "this redirect URI"}:`,
      app.redirect_uris,
    ),
  ];
}

export const UPDATE_SECRET_NOTE = "Nobody is disconnected.";

/** The warning before switching to another app. */
export function switchWarning(app: ConnectorApp, impact: ConnectorAppImpact): string[] {
  const lines = [
    `Everyone connected through the current app (${peopleIn(impact)}) will need to reconnect, and their agents lose ${app.name} until they do.`,
  ];
  if (app.kind === "github_app")
    lines.push("They will also need to choose their repositories again.");
  lines.push(
    `If the old app's secret leaked, also delete it at ${vendorName(app)}: tokens already handed to agents stay valid for up to an hour.`,
  );
  return lines;
}

export function removeWarning(app: ConnectorApp): string {
  const name = app.name;
  if (app.connected_members === 0) return `Nobody will be able to connect ${name}.`;
  const people =
    app.connected_members === 1 ? "the 1 person" : `the ${app.connected_members} people`;
  return `Nobody will be able to connect ${name}, and ${people} connected now lose it. They can still disconnect.`;
}

export interface Confirmation {
  label: string;
  /** What goes wrong when it isn't so. */
  why: string;
}

/** What the operator confirms before the check, because asking the vendor cannot show it. */
export function confirmBeforeCheck(app: Pick<ConnectorApp, "slug">): Confirmation | null {
  if (app.slug !== AIRTABLE) return null;
  return {
    label: "I've filled in its support details in Builder Hub.",
    why: "Support email, privacy policy URL and terms of service URL. Until all three are set, only the integration's owner can connect.",
  };
}

export interface ChecklistItem {
  text: string;
  done: boolean;
}

const HELM_VALUES: Record<string, string> = {
  github: "switchCore.githubConnectionsSecret and switchCore.githubAppPrivateKeyPath",
  [GOOGLE]: "switchCore.googleWorkspaceClientSecret",
  [AIRTABLE]: "switchCore.airtableClientSecret",
};

/** Moving off configuration: copy in, remove the configuration, restart. */
export function moveChecklist(app: ConnectorApp): ChecklistItem[] {
  const helm = HELM_VALUES[app.slug];
  return [
    { text: "Copy into Switch. Nothing is retyped.", done: waitingForRestart(app) },
    {
      text: `Remove ${variables(app)} from the server's configuration.${helm ? ` For Helm, that is ${helm}.` : ""}`,
      done: false,
    },
    { text: "Restart Switch.", done: false },
  ];
}

export const sentBackTo = (publicUrl: string): string => `People are sent back to ${publicUrl}.`;

/** Whether the page warns that GATEWAY_PUBLIC_URL is unset: only an app that needs it is held up. */
export function missingPublicUrl(apps: ConnectorApp[], publicUrl: string | null): boolean {
  return publicUrl === null && apps.some((app) => app.needs_public_url);
}

/** Whether an app can be set up or changed here now. */
export function changeBlocked(app: ConnectorApp, publicUrl: string | null): boolean {
  return (publicUrl === null && app.needs_public_url) || app.setup_blocked !== null;
}

export const PUBLIC_URL_BANNER =
  "Set GATEWAY_PUBLIC_URL first: Google and GitHub need to know where to send people back to Switch.";

export const ONLY_THE_OPERATOR =
  "Only the person who runs this Switch server can set up connectors.";
