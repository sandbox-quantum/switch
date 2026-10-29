import { describe, expect, it } from 'vitest';
import {
  actionLabel,
  appDetails,
  attention,
  audienceText,
  cardOrder,
  cardState,
  changeBlocked,
  configuredSentence,
  confirmBeforeCheck,
  menuActions,
  menuLabel,
  missingPublicUrl,
  moveChecklist,
  peopleIn,
  primaryAction,
  removeWarning,
  secretSummary,
  sentBackTo,
  setupInstructions,
  stateLabel,
  switchWarning,
  tileAction,
  tileStanding,
} from '@renderer/features/admin/connector-apps';
import {
  connectorAppSchema,
  redirectUris,
  type ConnectorApp,
} from '@shared/core/switch-servers/connector-apps';

/** A connector app as the server lists it, with placeholder values. */
function app(overrides: Partial<ConnectorApp> = {}): ConnectorApp {
  return {
    slug: 'google-workspace',
    name: 'Google Workspace',
    kind: 'oauth_client',
    source: 'saved',
    configuration_variables: ['GOOGLE_WORKSPACE_CLIENT_CONFIG_PATH'],
    deprecated: false,
    client_id: 'example-client-id',
    saved_client_id: 'example-client-id',
    fields: {},
    secrets: { client_secret: { set: true, last4: 'ab12' } },
    saved_ignored: false,
    unreadable: false,
    load_error: null,
    redirect_uri:
      'https://switch.example.test/gateway/service-connections/google-workspace/flows/callback',
    redirect_uris: [
      'https://switch.example.test/gateway/service-connections/google-workspace/flows/callback',
    ],
    needs_public_url: true,
    scopes: [],
    setup_blocked: null,
    install_url: null,
    updated_by_name: 'Ada',
    updated_at: '2026-10-15T10:00:00Z',
    connected_members: 12,
    workspaces: 3,
    stale_connections: 0,
    ...overrides,
  };
}

const PUBLIC_URL = 'https://switch.example.test';

const NONE = app({
  source: 'none',
  client_id: null,
  saved_client_id: null,
  secrets: { client_secret: { set: false, last4: null } },
  connected_members: 0,
  workspaces: 0,
});
const CONFIGURED = app({ source: 'configuration', saved_client_id: null });
const GITHUB = app({
  slug: 'github',
  name: 'GitHub',
  kind: 'github_app',
  configuration_variables: ['GITHUB_APP_CONFIG_PATH', 'GITHUB_APP_PRIVATE_KEY_PATH'],
  fields: { slug: 'example-app' },
  secrets: {
    client_secret: { set: true, last4: 'cd34' },
    private_key: { set: true, fingerprint: 'SHA256:example' },
  },
});

describe('card state', () => {
  it('is one of four', () => {
    expect(cardState(app(), null)).toBe('ready');
    expect(cardState(NONE, null)).toBe('not_set_up');
    expect(cardState(CONFIGURED, null)).toBe('configured');
    expect(cardState(app(), 'Google says no.')).toBe('attention');
    expect(
      ['ready', 'not_set_up', 'configured', 'attention'].map((s) => stateLabel(s as never))
    ).toEqual(['Ready', 'Not set up', 'Set on the server', 'Needs attention']);
  });

  it('names one cause and one fix for each kind of attention', () => {
    expect(attention(app(), "Google doesn't recognise this client.")).toEqual({
      cause: 'check_failed',
      sentence: "Google doesn't recognise this client.",
      action: 'update_secret',
    });
    expect(attention(app({ source: 'none', unreadable: true, load_error: 'x' }), null)).toEqual({
      cause: 'unreadable',
      sentence: "Switch can't read the saved secret any more.",
      action: 'enter_again',
    });
    expect(attention(app({ source: 'none', load_error: 'Not RSA.' }), null)?.cause).toBe(
      'load_error'
    );
    expect(
      attention(
        app({ source: 'configuration', saved_ignored: true, saved_client_id: 'other' }),
        null
      )
    ).toEqual({
      cause: 'saved_ignored',
      sentence:
        'Saved here, but GOOGLE_WORKSPACE_CLIENT_CONFIG_PATH is still set, so Switch uses that. Remove it and restart Switch.',
      action: 'manage_here',
    });
    expect(attention(app({ stale_connections: 5 }), null)).toEqual({
      cause: 'stale',
      sentence: '5 people still need to reconnect.',
      action: null,
    });
    expect(attention(app({ stale_connections: 1 }), null)?.sentence).toBe(
      '1 person still needs to reconnect.'
    );
    expect(attention(app(), null)).toBeNull();
  });

  it('does not call a copied-in app waiting for its restart a problem', () => {
    const waiting = app({ source: 'configuration', saved_ignored: true });
    expect(attention(waiting, null)).toBeNull();
    expect(cardState(waiting, null)).toBe('configured');
    expect(primaryAction(waiting, null)).toBeNull();
  });
});

describe('set-up blocked by the server', () => {
  const BLOCKED =
    'GitHub needs GATEWAY_PUBLIC_URL to be an https address, or a loopback http one (localhost, 127.0.0.1 or ::1), to send people back to Switch.';

  it("is the card's one sentence, with Set up as the fix", () => {
    const github = {
      ...GITHUB,
      source: 'none' as const,
      client_id: null,
      redirect_uri: null,
      setup_blocked: BLOCKED,
    };
    expect(attention(github, null)).toEqual({
      cause: 'setup_blocked',
      sentence: BLOCKED,
      action: 'set_up',
    });
    expect(primaryAction(github, null)).toBe('set_up');
  });

  it('leaves an app set on the server working', () => {
    const configured = { ...GITHUB, source: 'configuration' as const, setup_blocked: BLOCKED };
    expect(attention(configured, null)).toBeNull();
    expect(cardState(configured, null)).toBe('configured');
  });

  it('names where people are sent back to', () => {
    expect(sentBackTo('https://switch.example.test')).toBe(
      'People are sent back to https://switch.example.test.'
    );
  });
});

describe('set on the server', () => {
  it('names the variable, and how to change it or move off it', () => {
    expect(configuredSentence(CONFIGURED)).toBe(
      'From GOOGLE_WORKSPACE_CLIENT_CONFIG_PATH. Change it there, or remove it to manage it here.'
    );
    expect(configuredSentence({ ...GITHUB, source: 'configuration', saved_client_id: null })).toBe(
      'From GITHUB_APP_CONFIG_PATH and GITHUB_APP_PRIVATE_KEY_PATH. Change them there, or remove them to manage it here.'
    );
  });

  it('says a copy saved here under the same client is used once the variable goes', () => {
    const copied = app({ source: 'configuration', saved_ignored: true });
    expect(configuredSentence(copied)).toBe(
      'From GOOGLE_WORKSPACE_CLIENT_CONFIG_PATH. Change it there, or remove it to manage it here. A copy is saved here, same client. Remove the variable and restart Switch to use the copy.'
    );
    expect(configuredSentence(copied)).not.toMatch(/waiting for restart/);
  });

  it('leaves a copy of another client to the attention sentence', () => {
    const other = app({ source: 'configuration', saved_ignored: true, saved_client_id: 'other' });
    expect(configuredSentence(other)).toBe(
      'From GOOGLE_WORKSPACE_CLIENT_CONFIG_PATH. Change it there, or remove it to manage it here.'
    );
    expect(attention(other, null)?.cause).toBe('saved_ignored');
  });
});

describe('order', () => {
  it('puts what needs attention first, then not set up, then working', () => {
    const stale = app({ slug: 'a', name: 'A', stale_connections: 2 });
    const failing = app({ slug: 'b', name: 'B' });
    const ordered = cardOrder([app({ slug: 'z', name: 'Z' }), NONE, CONFIGURED, stale, failing], {
      b: 'No.',
    });
    expect(ordered.map((a) => a.name)).toEqual([
      'A',
      'B',
      'Google Workspace',
      'Google Workspace',
      'Z',
    ]);
    expect(ordered[2]!.source).toBe('none');
    expect(ordered[3]!.source).toBe('configuration');
  });
});

describe('actions', () => {
  it('offers one obvious button per state', () => {
    expect(primaryAction(NONE, null)).toBe('set_up');
    expect(actionLabel(NONE, 'set_up')).toBe('Set up Google Workspace');
    expect(actionLabel(GITHUB, 'set_up')).toBe('Set up GitHub');
    expect(primaryAction(CONFIGURED, null)).toBe('manage_here');
    expect(primaryAction(app(), null)).toBe('check');
    expect(primaryAction(app(), 'No.')).toBe('update_secret');
    expect(primaryAction(app({ source: 'none', unreadable: true }), null)).toBe('enter_again');
    expect(primaryAction(app({ stale_connections: 3 }), null)).toBe('check');
    expect(primaryAction(app({ source: 'configuration', deprecated: true }), null)).toBeNull();
  });

  it('splits changes by what they do to the people connected', () => {
    expect(menuActions(app())).toEqual(['update_secret', 'switch_app', 'remove']);
    expect(menuActions(NONE)).toEqual([]);
    expect(menuActions(CONFIGURED)).toEqual([]);
    expect(menuActions(app({ source: 'none', unreadable: true }))).toEqual(['remove']);
    expect(menuLabel(app(), 'update_secret')).toBe('Update secret');
    expect(menuLabel(GITHUB, 'update_secret')).toBe('Update secret or private key');
    expect(menuLabel(app(), 'switch_app')).toBe('Use a different app');
  });
});

describe('wording', () => {
  it('counts people and workspaces', () => {
    expect(peopleIn({ connected_members: 12, workspaces: 3 })).toBe('12 people in 3 workspaces');
    expect(peopleIn({ connected_members: 1, workspaces: 1 })).toBe('1 person in 1 workspace');
  });

  it("warns before switching apps, GitHub's repositories included", () => {
    expect(switchWarning(app(), { connected_members: 12, workspaces: 3 })).toEqual([
      'Everyone connected through the current app (12 people in 3 workspaces) will need to reconnect, and their agents lose Google Workspace until they do.',
      "If the old app's secret leaked, also delete it at Google: tokens already handed to agents stay valid for up to an hour.",
    ]);
    expect(switchWarning(GITHUB, { connected_members: 2, workspaces: 1 })).toContain(
      'They will also need to choose their repositories again.'
    );
  });

  it('says who loses a removed app', () => {
    expect(removeWarning(app())).toBe(
      'Nobody will be able to connect Google Workspace, and the 12 people connected now lose it. They can still disconnect.'
    );
    expect(removeWarning(NONE)).toBe('Nobody will be able to connect Google Workspace.');
  });

  it('shows how to recognise a secret, never the secret', () => {
    expect(secretSummary(app())).toBe('Secret ends in ab12');
    expect(secretSummary(GITHUB)).toBe('Secret ends in cd34 · Key SHA256:example');
    expect(secretSummary(NONE)).toBeNull();
  });

  it('changes only the instructions with who will connect', () => {
    const internal = setupInstructions(NONE, 'internal', PUBLIC_URL);
    const external = setupInstructions(NONE, 'external', PUBLIC_URL);
    expect(internal[2]!.text).toBe(audienceText('internal'));
    expect(external[2]!.text).toBe(audienceText('external'));
    expect(internal.filter((_, i) => i !== 2)).toEqual(external.filter((_, i) => i !== 2));
    expect(audienceText('external')).toMatch(/add the people who will try it as test users/);
    expect(audienceText('external')).toMatch(/reconnect every 7 days/);
    expect(audienceText('external')).toMatch(/security assessment renewed every year/);
  });

  it("walks Google's set-up page by page, each with its link", () => {
    const steps = setupInstructions(NONE, 'internal', PUBLIC_URL);
    expect(steps.map((s) => s.link?.href ?? null)).toEqual([
      'https://console.cloud.google.com/projectcreate',
      'https://console.cloud.google.com/auth/branding',
      'https://console.cloud.google.com/auth/audience',
      'https://console.cloud.google.com/auth/clients',
      null,
      'https://console.cloud.google.com/apis/library',
    ]);
    expect(steps[1]!.text).toMatch(/app name .* support email/);
    expect(steps[4]!.copy).toEqual([NONE.redirect_uri]);
    expect(steps[5]!.text).toBe(
      'Enable the Google Drive, Docs, Sheets, Slides and Calendar APIs for the project.'
    );
  });

  it("walks GitHub's form from top to bottom, with what to paste", () => {
    const steps = setupInstructions(GITHUB, 'internal', PUBLIC_URL);
    expect(steps[0]!.link).toEqual({
      label: 'Open GitHub',
      href: 'https://github.com/settings/apps/new',
    });
    expect(steps.slice(1).every((s) => s.link === null)).toBe(true);
    expect(steps.flatMap((s) => s.copy)).toEqual([PUBLIC_URL, GITHUB.redirect_uri]);
    const texts = steps.map((s) => s.text);
    expect(texts[1]).toMatch(/^Set the Homepage URL/);
    expect(texts[2]).toMatch(/^Set the Callback URL/);
    expect(texts[3]).toMatch(/Expire user authorization tokens turned on/);
    expect(texts[4]).toMatch(/^Under Webhook, untick Active/);
    expect(texts[5]).toMatch(/Contents and Pull requests to Read and write/);
    expect(texts[6]).toMatch(/Where can this GitHub App be installed, choose Any account/);
    expect(texts[7]).toMatch(/generate a client secret, then a private key/);
  });

  it("links only to the vendors' public pages", () => {
    const links = [
      ...setupInstructions(NONE, 'external', PUBLIC_URL),
      ...setupInstructions(GITHUB, 'internal', PUBLIC_URL),
    ].flatMap((s) => (s.link ? [s.link.href] : []));
    expect(
      links.every((href) => /^https:\/\/(console\.cloud\.google\.com|github\.com)\//.test(href))
    ).toBe(true);
  });
});

const LOOPBACK_REDIRECTS = [39231, 39232, 39233, 39234, 39235].map(
  (port) => `http://127.0.0.1:${port}/switch-services/callback`
);

const AIRTABLE_CALLBACK = `${PUBLIC_URL}/gateway/service-connections/airtable/flows/callback`;

const AIRTABLE = app({
  slug: 'airtable',
  name: 'Airtable',
  source: 'none',
  client_id: null,
  saved_client_id: null,
  configuration_variables: ['AIRTABLE_CLIENT_CONFIG_PATH'],
  secrets: { client_secret: { set: false, last4: null } },
  redirect_uri: AIRTABLE_CALLBACK,
  redirect_uris: [AIRTABLE_CALLBACK],
  needs_public_url: true,
  scopes: ['data.records:read', 'data.records:write'],
  updated_at: null,
  connected_members: 0,
  workspaces: 0,
});

/** An app whose sign-ins return to Switch Console, on one of several ports. */
const LOOPBACK = app({
  ...AIRTABLE,
  slug: 'example',
  name: 'Example',
  redirect_uri: LOOPBACK_REDIRECTS[0]!,
  redirect_uris: LOOPBACK_REDIRECTS,
  needs_public_url: false,
});

describe('Airtable, and an app that sends people back to Switch Console', () => {
  it('asks the operator to confirm what no check can see: that the integration is published', () => {
    expect(confirmBeforeCheck(AIRTABLE)?.label).toBe(
      "I've filled in its support details in Builder Hub."
    );
    expect(confirmBeforeCheck(AIRTABLE)?.why).toMatch(
      /privacy policy URL and terms of service URL\. Until all three are set, only the integration's owner can connect/
    );
    expect(confirmBeforeCheck(NONE)).toBeNull();
  });

  it("walks Airtable's Builder Hub, with its redirect to paste and the scopes to tick", () => {
    const steps = setupInstructions(AIRTABLE, 'internal', null);
    expect(steps[0]!.link).toEqual({
      label: 'Open Builder Hub',
      href: 'https://airtable.com/create/oauth',
    });
    expect(steps[0]!.text).toMatch(/account your organization owns/);
    expect(steps.flatMap((s) => s.copy)).toEqual([AIRTABLE_CALLBACK]);
    expect(new Set(steps.map((s) => s.text)).size).toBe(steps.length);
    const texts = steps.map((s) => s.text);
    expect(steps.find((s) => s.text === 'Under Scopes, tick exactly these:')?.items).toEqual([
      'data.records:read, data.records:write',
    ]);
    expect(steps.filter((s) => s.copy.length > 0)).toHaveLength(1);
    expect(texts.at(-1)).toMatch(/support email, privacy policy URL and terms of service URL/);
  });

  it('an app that sends people back to Switch Console needs no public URL, and raises no banner', () => {
    expect(changeBlocked(LOOPBACK, null)).toBe(false);
    expect(changeBlocked(NONE, null)).toBe(true);
    expect(missingPublicUrl([LOOPBACK], null)).toBe(false);
    expect(missingPublicUrl([LOOPBACK, NONE], null)).toBe(true);
    expect(missingPublicUrl([LOOPBACK, NONE], PUBLIC_URL)).toBe(false);
    expect(changeBlocked(AIRTABLE, null)).toBe(true);
  });

  it('lists every redirect, and sends people back to Switch Console', () => {
    const details = appDetails(LOOPBACK, PUBLIC_URL, (iso) => iso);
    const setup = details.find((section) => section.title === 'Setup')!;
    expect(setup.rows.filter((r) => r.code).map((r) => [r.label, r.value])).toEqual(
      LOOPBACK_REDIRECTS.map((redirect, index) => [`Redirect URI ${index + 1}`, redirect])
    );
    expect(details.at(-1)!.rows.map((r) => [r.label, r.value])).toEqual([
      ['Sent back to', 'Switch Console, on their computer'],
    ]);
  });

  it("names Airtable's Helm value when moving off configuration", () => {
    expect(moveChecklist(app({ ...AIRTABLE, source: 'configuration' }))[1]!.text).toBe(
      "Remove AIRTABLE_CLIENT_CONFIG_PATH from the server's configuration. For Helm, that is switchCore.airtableClientSecret."
    );
  });

  it('reads a server older than these fields as it always did', () => {
    const { redirect_uris, needs_public_url, scopes, ...older } = app();
    void redirect_uris;
    void needs_public_url;
    void scopes;
    const parsed = connectorAppSchema.parse(older);
    expect(parsed.needs_public_url).toBe(true);
    expect(parsed.scopes).toEqual([]);
    expect(redirectUris(parsed)).toEqual([older.redirect_uri]);
    expect(redirectUris({ redirect_uri: null, redirect_uris: undefined })).toEqual([]);
  });
});

describe('moving off configuration', () => {
  it('ticks copying in once the saved app matches, and names the Helm value', () => {
    const before = moveChecklist(CONFIGURED);
    expect(before.map((item) => item.done)).toEqual([false, false, false]);
    expect(before[1]!.text).toBe(
      "Remove GOOGLE_WORKSPACE_CLIENT_CONFIG_PATH from the server's configuration. For Helm, that is switchCore.googleWorkspaceClientSecret."
    );
    const after = moveChecklist(app({ source: 'configuration', saved_ignored: true }));
    expect(after.map((item) => item.done)).toEqual([true, false, false]);
  });
});

describe('a tile', () => {
  it('says what needs doing, or who the app serves', () => {
    expect(tileStanding(NONE, null)).toBe(
      "People can't connect Google Workspace until you add Switch's Google client."
    );
    expect(tileStanding(app(), 'Google refused the secret.')).toBe('Google refused the secret.');
    expect(tileStanding(app(), null)).toBe('Used by 12 people in 3 workspaces');
    expect(tileStanding(CONFIGURED, null)).toBe('Used by 12 people in 3 workspaces');
  });

  it('carries only the one thing that needs doing', () => {
    expect(tileAction(NONE, null)).toBe('set_up');
    expect(tileAction(app(), 'Google refused the secret.')).toBe('update_secret');
    expect(tileAction(app({ unreadable: true }), null)).toBe('enter_again');
    // Checking and moving off configuration are the profile's.
    expect(tileAction(app(), null)).toBeNull();
    expect(tileAction(CONFIGURED, null)).toBeNull();
  });
});

describe("an app's details", () => {
  const date = (iso: string) => `on ${iso}`;
  const shape = (sections: ReturnType<typeof appDetails>) =>
    sections.map((section) => [section.title, section.rows.map((r) => r.label)]);

  it('are in the same three sections for every app, each with what it has', () => {
    expect(shape(appDetails(app(), PUBLIC_URL, date))).toEqual([
      ['Credentials', ['Client ID', 'Client secret']],
      ['Setup', ['Source', 'Redirect URI', 'Last changed']],
      ['For people who connect', ['Sent back to']],
    ]);
    const installed = {
      ...GITHUB,
      install_url: 'https://github.com/apps/example-app/installations/new',
    };
    expect(shape(appDetails(installed, PUBLIC_URL, date))).toEqual([
      ['Credentials', ['Client ID', 'GitHub App', 'Client secret', 'Private key']],
      ['Setup', ['Source', 'Callback URL', 'Last changed']],
      ['For people who connect', ['Sent back to', 'Install page']],
    ]);
  });

  it('show identifiers to copy, a secret by its last characters, and never more', () => {
    const [credentials] = appDetails(GITHUB, PUBLIC_URL, date);
    const byLabel = Object.fromEntries(credentials!.rows.map((r) => [r.label, r]));
    expect(byLabel['Client ID']).toMatchObject({ code: true });
    expect(byLabel['Client secret']).toMatchObject({
      value: expect.stringMatching(/^•••• /),
      code: false,
    });
    expect(byLabel['Private key']).toMatchObject({ code: true });
    expect(byLabel['GitHub App']!.href).toBe('https://github.com/apps/example-app');
  });

  it('name a value an app added later from its key', () => {
    const later = app({
      fields: { tenant_domain: 'example.test' } as ConnectorApp['fields'],
      secrets: { signing_key: { set: true, last4: 'zz99' } },
    });
    expect(appDetails(later, null, date)[0]!.rows.map((r) => [r.label, r.value])).toEqual([
      ['Client ID', 'example-client-id'],
      ['Tenant domain', 'example.test'],
      ['Signing key', '•••• zz99'],
    ]);
  });

  it('say where an app comes from, who changed it, and who must reconnect', () => {
    const setup = (a: ConnectorApp) =>
      Object.fromEntries(appDetails(a, null, date)[1]!.rows.map((r) => [r.label, r.value]));
    expect(setup(app())).toMatchObject({
      Source: 'Saved in Switch',
      'Last changed': 'Ada · on 2026-10-15T10:00:00Z',
    });
    expect(setup(CONFIGURED).Source).toBe(
      'Server configuration (GOOGLE_WORKSPACE_CLIENT_CONFIG_PATH)'
    );
    expect(setup(NONE)).toMatchObject({ Source: 'Not set up' });
    const people = appDetails(app({ stale_connections: 2 }), PUBLIC_URL, date).at(-1)!;
    expect(people.rows.map((r) => [r.label, r.value])).toEqual([
      ['Sent back to', PUBLIC_URL],
      ['Need to reconnect', '2 people'],
    ]);
  });
});
