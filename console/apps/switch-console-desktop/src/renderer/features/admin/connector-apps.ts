/**
 * What the Admin page's Connector apps tab shows, decided here and only
 * displayed by the components: each app's state, the one sentence and button
 * that go with it, the order, which actions it offers, and the wording of
 * every dialog. Labels follow what Google and GitHub call things, so the
 * operator can copy values across. The gateway dashboard's page reads the
 * same rules from its own copy, until that page is retired.
 */
import type {
  ConnectorApp,
  ConnectorAppField,
  ConnectorAppImpact,
} from '@shared/core/switch-servers/connector-apps';

export type CardState = 'ready' | 'not_set_up' | 'configured' | 'attention';

export type AttentionCause =
  | 'setup_blocked'
  | 'check_failed'
  | 'unreadable'
  | 'load_error'
  | 'saved_ignored'
  | 'stale';

export type CardAction = 'set_up' | 'manage_here' | 'check' | 'update_secret' | 'enter_again';

export interface Attention {
  cause: AttentionCause;
  sentence: string;
  /** The one fix offered beside the sentence; null where there is nothing to press. */
  action: CardAction | null;
}

export type MenuAction = 'update_secret' | 'switch_app' | 'remove';

export type Audience = 'internal' | 'external';

export interface Instruction {
  text: string;
  /** A value to paste at the vendor, offered with a copy button. */
  copy: string | null;
  /** The vendor's page for this step, where it has one of its own. */
  link: { label: string; href: string } | null;
}

export interface SecretField {
  name: Exclude<ConnectorAppField, 'client_id'>;
  label: string;
  /** A file the browser reads (the .pem), never shown. */
  file: boolean;
}

const GOOGLE = 'google-workspace';

export function vendorName(app: Pick<ConnectorApp, 'slug' | 'kind' | 'name'>): string {
  if (app.kind === 'github_app') return 'GitHub';
  if (app.slug === GOOGLE) return 'Google';
  return app.name;
}

/** "12 people in 3 workspaces", "1 person in 1 workspace". */
export function peopleIn(usage: ConnectorAppImpact): string {
  const people = usage.connected_members === 1 ? '1 person' : `${usage.connected_members} people`;
  const workspaces = usage.workspaces === 1 ? '1 workspace' : `${usage.workspaces} workspaces`;
  return `${people} in ${workspaces}`;
}

function variables(app: ConnectorApp): string {
  return app.configuration_variables.join(' and ');
}

/** Copied into Switch, and waiting for the configuration to be removed. */
export function waitingForRestart(app: ConnectorApp): boolean {
  return (
    app.source === 'configuration' &&
    app.saved_ignored &&
    app.saved_client_id !== null &&
    app.saved_client_id === app.client_id
  );
}

/** What needs the operator, most pressing first; null when nothing does. */
export function attention(app: ConnectorApp, checkFailure: string | null): Attention | null {
  // A configured app keeps working: only setting one up here is blocked.
  if (app.setup_blocked !== null && app.source !== 'configuration')
    return { cause: 'setup_blocked', sentence: app.setup_blocked, action: 'set_up' };
  if (checkFailure !== null)
    return { cause: 'check_failed', sentence: checkFailure, action: 'update_secret' };
  if (app.unreadable)
    return {
      cause: 'unreadable',
      sentence: "Switch can't read the saved secret any more.",
      action: 'enter_again',
    };
  if (app.load_error !== null)
    return { cause: 'load_error', sentence: app.load_error, action: 'enter_again' };
  if (app.saved_ignored && !waitingForRestart(app))
    return {
      cause: 'saved_ignored',
      sentence: `Saved here, but ${variables(app)} is still set, so Switch uses that. Remove it and restart Switch.`,
      action: 'manage_here',
    };
  if (app.stale_connections > 0)
    return {
      cause: 'stale',
      sentence:
        app.stale_connections === 1
          ? '1 person still needs to reconnect.'
          : `${app.stale_connections} people still need to reconnect.`,
      action: null,
    };
  return null;
}

export function cardState(app: ConnectorApp, checkFailure: string | null): CardState {
  if (attention(app, checkFailure) !== null) return 'attention';
  if (app.source === 'configuration') return 'configured';
  if (app.source === 'saved') return 'ready';
  return 'not_set_up';
}

export function stateLabel(state: CardState): string {
  switch (state) {
    case 'ready':
      return 'Ready';
    case 'not_set_up':
      return 'Not set up';
    case 'configured':
      return 'Set on the server';
    case 'attention':
      return 'Needs attention';
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
  checkFailures: Record<string, string>
): ConnectorApp[] {
  return [...apps].sort(
    (a, b) =>
      ORDER[cardState(a, checkFailures[a.slug] ?? null)] -
        ORDER[cardState(b, checkFailures[b.slug] ?? null)] || a.name.localeCompare(b.name)
  );
}

export function notSetUpSentence(app: ConnectorApp): string {
  return app.kind === 'github_app'
    ? "People can't connect GitHub until you add Switch's GitHub App."
    : `People can't connect ${app.name} until you add Switch's ${vendorName(app)} client.`;
}

/** The card's one obvious button. */
export function primaryAction(app: ConnectorApp, checkFailure: string | null): CardAction | null {
  const state = cardState(app, checkFailure);
  if (state === 'not_set_up') return 'set_up';
  if (state === 'attention') {
    const fix = attention(app, checkFailure)?.action ?? null;
    return fix ?? (app.source === 'none' ? null : 'check');
  }
  if (state === 'configured')
    return app.deprecated || waitingForRestart(app) ? null : 'manage_here';
  return 'check';
}

export function actionLabel(app: ConnectorApp, action: CardAction): string {
  switch (action) {
    case 'set_up':
      return `Set up ${app.kind === 'github_app' ? 'GitHub' : app.name}`;
    case 'manage_here':
      return 'Manage it here instead';
    case 'check':
      return 'Check it works';
    case 'update_secret':
      return 'Update secret';
    case 'enter_again':
      return 'Enter it again';
  }
}

/** The ⋯ menu: changes split by what they do to the people connected. */
export function menuActions(app: ConnectorApp): MenuAction[] {
  if (app.source === 'saved') return ['update_secret', 'switch_app', 'remove'];
  // Saved, but unusable: it can be entered again, or removed.
  if (app.source === 'none' && app.saved_client_id !== null) return ['remove'];
  return [];
}

export function menuLabel(app: ConnectorApp, action: MenuAction): string {
  switch (action) {
    case 'update_secret':
      return app.kind === 'github_app' ? 'Update secret or private key' : 'Update secret';
    case 'switch_app':
      return 'Use a different app';
    case 'remove':
      return 'Remove';
  }
}

export function configuredSentence(app: ConnectorApp): string {
  if (app.deprecated)
    return 'Using HOSTED_GITHUB_CONFIG_PATH, which names no private key, so GitHub can be connected but not granted. Set up the GitHub App here instead, after unsetting it.';
  const one = app.configuration_variables.length === 1;
  const from = `From ${variables(app)}. Change ${one ? 'it' : 'them'} there, or remove ${one ? 'it' : 'them'} to manage it here.`;
  if (waitingForRestart(app))
    return `${from} A copy is saved here, same client. Remove the ${one ? 'variable' : 'variables'} and restart Switch to use the copy.`;
  return from;
}

export function secretFields(app: Pick<ConnectorApp, 'kind'>): SecretField[] {
  const secret: SecretField = { name: 'client_secret', label: 'Client secret', file: false };
  return app.kind === 'github_app'
    ? [secret, { name: 'private_key', label: 'Private key', file: true }]
    : [secret];
}

/** "ends in ab12", or a key's fingerprint. */
export function secretSummary(app: ConnectorApp): string | null {
  const secret = app.secrets.client_secret;
  const parts = [];
  if (secret?.set) parts.push(secret.last4 ? `Secret ends in ${secret.last4}` : 'Secret set');
  const key = app.secrets.private_key;
  if (key?.set) parts.push(key.fingerprint ? `Key ${key.fingerprint}` : 'Key set');
  return parts.length ? parts.join(' · ') : null;
}

export function usedBy(app: ConnectorApp): string {
  return `Used by ${peopleIn(app)}`;
}

/** Google's choice of who may connect; it changes only the instructions. */
export function asksWhoConnects(app: Pick<ConnectorApp, 'slug'>): boolean {
  return app.slug === GOOGLE;
}

export function audienceText(audience: Audience): string {
  return audience === 'internal'
    ? "Under Audience, choose Internal. Only people in your Google organization can connect, and Google doesn't need to review the app."
    : "Under Audience, choose External, and add the people who will try it as test users. Until Google verifies the app, only test users can connect, and they must reconnect every 7 days. Because Switch reads Drive, Google's review includes a security assessment renewed every year.";
}

const GOOGLE_CLOUD = 'https://console.cloud.google.com';

/** Step 1 of setting up: creating the app at the vendor, one page at a time. */
export function setupInstructions(
  app: ConnectorApp,
  audience: Audience,
  publicUrl: string | null
): Instruction[] {
  const redirect = app.redirect_uri;
  if (app.kind === 'github_app')
    return [
      {
        text: "In GitHub, create a new GitHub App: Settings, Developer settings, GitHub Apps. For an App owned by an organization, start from the organization's settings instead.",
        copy: null,
        link: { label: 'Open GitHub', href: 'https://github.com/settings/apps/new' },
      },
      { text: "Set the Homepage URL to Switch's public URL:", copy: publicUrl, link: null },
      { text: 'Set the Callback URL to:', copy: redirect, link: null },
      { text: 'Keep Expire user authorization tokens turned on.', copy: null, link: null },
      {
        text: "Under Webhook, untick Active. Switch doesn't use GitHub's webhooks, and GitHub asks for a webhook URL while it is ticked.",
        copy: null,
        link: null,
      },
      {
        text: 'Under Repository permissions, set Contents and Pull requests to Read and write.',
        copy: null,
        link: null,
      },
      {
        text: "Under Where can this GitHub App be installed, choose Any account, so people can install it on their own accounts and organizations. Choose Only on this account only if every member's repositories are in your own organization.",
        copy: null,
        link: null,
      },
      {
        text: 'Create the GitHub App. On its page, generate a client secret, then a private key, and keep the downloaded .pem file.',
        copy: null,
        link: null,
      },
    ];
  if (app.slug === GOOGLE)
    return [
      {
        text: 'In Google Cloud, create a project for Switch, or pick an existing one.',
        copy: null,
        link: { label: 'Create a project', href: `${GOOGLE_CLOUD}/projectcreate` },
      },
      {
        text: 'In Google Auth Platform, under Branding, enter an app name people will recognise and a support email.',
        copy: null,
        link: { label: 'Open Branding', href: `${GOOGLE_CLOUD}/auth/branding` },
      },
      {
        text: audienceText(audience),
        copy: null,
        link: { label: 'Open Audience', href: `${GOOGLE_CLOUD}/auth/audience` },
      },
      {
        text: 'Under Clients, create a client of type Web application.',
        copy: null,
        link: { label: 'Open Clients', href: `${GOOGLE_CLOUD}/auth/clients` },
      },
      {
        text: 'Add this under Authorized redirect URIs, create the client, and copy its Client ID and Client secret:',
        copy: redirect,
        link: null,
      },
      {
        text: 'Enable the Google Drive, Docs, Sheets, Slides and Calendar APIs for the project.',
        copy: null,
        link: { label: 'Open the API Library', href: `${GOOGLE_CLOUD}/apis/library` },
      },
    ];
  return [
    {
      text: `Register an OAuth client for Switch at ${app.name}, with this redirect URI:`,
      copy: redirect,
      link: null,
    },
  ];
}

export const UPDATE_SECRET_NOTE = 'Nobody is disconnected.';

/** The warning before switching to another app. */
export function switchWarning(app: ConnectorApp, impact: ConnectorAppImpact): string[] {
  const lines = [
    `Everyone connected through the current app (${peopleIn(impact)}) will need to reconnect, and their agents lose ${app.name} until they do.`,
  ];
  if (app.kind === 'github_app')
    lines.push('They will also need to choose their repositories again.');
  lines.push(
    `If the old app's secret leaked, also delete it at ${vendorName(app)}: tokens already handed to agents stay valid for up to an hour.`
  );
  return lines;
}

export function removeWarning(app: ConnectorApp): string {
  const name = app.name;
  if (app.connected_members === 0) return `Nobody will be able to connect ${name}.`;
  const people =
    app.connected_members === 1 ? 'the 1 person' : `the ${app.connected_members} people`;
  return `Nobody will be able to connect ${name}, and ${people} connected now lose it. They can still disconnect.`;
}

export interface ChecklistItem {
  text: string;
  done: boolean;
}

const HELM_VALUES: Record<string, string> = {
  github: 'switchCore.githubConnectionsSecret and switchCore.githubAppPrivateKeyPath',
  [GOOGLE]: 'switchCore.googleWorkspaceClientSecret',
};

/** Moving off configuration: copy in, remove the configuration, restart. */
export function moveChecklist(app: ConnectorApp): ChecklistItem[] {
  const helm = HELM_VALUES[app.slug];
  return [
    { text: 'Copy into Switch. Nothing is retyped.', done: waitingForRestart(app) },
    {
      text: `Remove ${variables(app)} from the server's configuration.${helm ? ` For Helm, that is ${helm}.` : ''}`,
      done: false,
    },
    { text: 'Restart Switch.', done: false },
  ];
}

export const sentBackTo = (publicUrl: string): string => `People are sent back to ${publicUrl}.`;

export const PUBLIC_URL_BANNER =
  'Set GATEWAY_PUBLIC_URL first: Google and GitHub need to know where to send people back to Switch.';

export const ONLY_THE_OPERATOR =
  'Only the person who runs this Switch server can set up connectors.';

/** The badge variant for a state: attention reads as a problem, working as done. */
export const STATE_BADGE = {
  attention: 'destructive',
  not_set_up: 'secondary',
  configured: 'outline',
  ready: 'outline',
} as const satisfies Record<CardState, string>;

/**
 * The tile's one line: what needs doing, or who it serves. The long account
 * of where a configured app comes from is the profile's.
 */
export function tileStanding(app: ConnectorApp, checkFailure: string | null): string {
  const needs = attention(app, checkFailure);
  if (needs !== null) return needs.sentence;
  if (cardState(app, checkFailure) === 'not_set_up') return notSetUpSentence(app);
  return usedBy(app);
}

/**
 * The button a tile carries beside its badge: setting up, or the one fix
 * for what needs attention. Checking and moving off configuration are not
 * urgent, so they are the profile's.
 */
export function tileAction(
  app: ConnectorApp,
  checkFailure: string | null
): Exclude<CardAction, 'check' | 'manage_here'> | null {
  const action = primaryAction(app, checkFailure);
  return action === 'check' || action === 'manage_here' ? null : action;
}

export interface DetailRow {
  label: string;
  value: string;
  /** An identifier, shown in a fixed-width face with a copy button. */
  code: boolean;
  href: string | null;
}

export interface DetailSection {
  title: string;
  rows: DetailRow[];
}

/** What GitHub and Google call each value; anything newer is named from its key. */
const DETAIL_LABELS: Record<string, string> = {
  client_secret: 'Client secret',
  private_key: 'Private key',
  slug: 'GitHub App',
};

function detailLabel(name: string): string {
  const known = DETAIL_LABELS[name];
  if (known) return known;
  const words = name.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function row(label: string, value: string, code = false, href: string | null = null): DetailRow {
  return { label, value, code, href };
}

/**
 * An app's details in the same three sections for every app, so the
 * operator finds a value in the same place whichever app it is: what
 * identifies it at the vendor, how Switch holds it, and what it means for
 * the people who connect. The values an app has are read from what the
 * server sends (its fields and its secrets), so an app added later shows
 * its own with no change here; a section with nothing to say is left out.
 */
export function appDetails(
  app: ConnectorApp,
  publicUrl: string | null,
  formatDate: (iso: string) => string
): DetailSection[] {
  const credentials: DetailRow[] = [];
  const clientId = app.client_id ?? app.saved_client_id;
  if (clientId !== null) credentials.push(row('Client ID', clientId, true));
  for (const [name, value] of Object.entries(app.fields)) {
    if (!value) continue;
    credentials.push(
      name === 'slug' && app.kind === 'github_app'
        ? row(detailLabel(name), value, false, `https://github.com/apps/${value}`)
        : row(detailLabel(name), value)
    );
  }
  for (const [name, secret] of Object.entries(app.secrets)) {
    const label = detailLabel(name);
    if (!secret.set) credentials.push(row(label, 'Not set'));
    else if (secret.fingerprint) credentials.push(row(label, secret.fingerprint, true));
    else if (secret.last4) credentials.push(row(label, `•••• ${secret.last4}`));
    else credentials.push(row(label, 'Set'));
  }

  const setup: DetailRow[] = [
    row(
      'Source',
      app.source === 'configuration'
        ? `Server configuration (${variables(app)})`
        : app.source === 'saved'
          ? 'Saved in Switch'
          : 'Not set up'
    ),
  ];
  if (app.redirect_uri !== null)
    setup.push(
      row(app.kind === 'github_app' ? 'Callback URL' : 'Redirect URI', app.redirect_uri, true)
    );
  if (app.updated_at !== null)
    setup.push(
      row(
        'Last changed',
        `${app.updated_by_name ?? 'A deleted account'} · ${formatDate(app.updated_at)}`
      )
    );

  const people: DetailRow[] = [];
  if (publicUrl !== null) people.push(row('Sent back to', publicUrl));
  if (app.install_url !== null)
    people.push(row('Install page', app.install_url, false, app.install_url));
  if (app.stale_connections > 0)
    people.push(
      row(
        'Need to reconnect',
        app.stale_connections === 1 ? '1 person' : `${app.stale_connections} people`
      )
    );

  return [
    { title: 'Credentials', rows: credentials },
    { title: 'Setup', rows: setup },
    { title: 'For people who connect', rows: people },
  ].filter((section) => section.rows.length > 0);
}
