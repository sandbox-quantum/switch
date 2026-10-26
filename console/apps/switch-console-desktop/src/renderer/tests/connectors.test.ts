import { describe, expect, it } from 'vitest';
import {
  type ConnectFlowState,
  canCloseConnectFlow,
  connectFlowReducer,
  initialConnectFlow,
} from '@renderer/features/connectors/connect-flow';
import {
  type ConnectorViewer,
  connectorCardState,
} from '@renderer/features/connectors/connector-card-state';
import {
  disconnectCopy,
  switchOffConfirmation,
  workspaceSwitchNote,
} from '@renderer/features/connectors/connector-copy';
import {
  cardQuickAction,
  connectedAsLine,
  connectorsInTab,
  connectorsPageAccess,
  defaultConnectorsTab,
  keyAccessText,
  profileConnectAction,
  signInLabel,
  tokenLifetimeLabel,
  workspaceOffNotice,
} from '@renderer/features/connectors/connectors-catalog';
import {
  repositoriesActionLabel,
  repositoriesSummary,
} from '@renderer/features/connectors/github-access';
import {
  emptyGitHubGrant,
  githubChoiceSummary,
  githubGrantResources,
  withEveryRepository,
  withInstallation,
  withRepository,
  withoutRepository,
} from '@renderer/features/connectors/github-grant';
import {
  OPEN_AGENT_NOTE,
  addableAgents,
  agentsSummary,
  agentsUnlistedText,
  noAgentsText,
  offersAddAgent,
} from '@renderer/features/connectors/grant-agents';
import { adminNavTarget, workspaceNavViews } from '@renderer/features/sidebar/workspace-nav-views';
import {
  FLAGS_NOT_READ_YET,
  allFeatureFlagsOff,
  type ServerFeatureFlags,
} from '@shared/core/feature-flags/feature-flags';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import { RpcError, serializeRpcError } from '@shared/lib/ipc/rpc-error';

function entry(overrides: Partial<ConnectionCatalogEntry> = {}): ConnectionCatalogEntry {
  return {
    slug: 'example',
    name: 'Example',
    category: 'Project management',
    description: 'Example work items.',
    enabled: true,
    auth_type: 'oauth',
    connectable: true,
    status: 'not_connected',
    unavailable_reason: null,
    unavailable_code: null,
    pass_through: true,
    token_lifetime: 3600,
    loopback_ports: null,
    key: null,
    external_identity: null,
    consent: null,
    workspace_enabled: true,
    ...overrides,
  };
}

const MEMBER: ConnectorViewer = { operator: false, administers: false, onThisComputer: false };

describe('the state a connector card shows', () => {
  it('shows each state on its own', () => {
    expect(connectorCardState(entry({ status: 'coming_soon', enabled: false }), MEMBER).kind).toBe(
      'coming_soon'
    );
    expect(
      connectorCardState(entry({ unavailable_reason: 'Maintenance', connectable: false }), MEMBER)
    ).toMatchObject({ kind: 'unavailable', detail: 'Maintenance' });
    expect(connectorCardState(entry({ workspace_enabled: false }), MEMBER)).toMatchObject({
      kind: 'workspace_off',
      label: 'Off in this workspace',
      detail: 'Ask a workspace admin to turn it on.',
      fix: null,
    });
    expect(connectorCardState(entry({ status: 'needs_reauthorization' }), MEMBER)).toMatchObject({
      kind: 'reconnect',
      label: 'Reconnect needed',
      detail: 'Switch can no longer use your Example connection. Connect again.',
      tone: 'problem',
    });
    expect(connectorCardState(entry({ status: 'error' }), MEMBER)).toMatchObject({
      kind: 'reconnect',
      label: 'Connection failed',
    });
    expect(connectorCardState(entry({ status: 'connected' }), MEMBER).kind).toBe('connected');
    expect(connectorCardState(entry(), MEMBER).kind).toBe('connect');
  });

  it('reads a server without the workspace switch as on', () => {
    expect(connectorCardState(entry({ workspace_enabled: null }), MEMBER).kind).toBe('connect');
    expect(
      connectorCardState(entry({ workspace_enabled: null, status: 'connected' }), MEMBER).kind
    ).toBe('connected');
  });

  it('picks the first that applies when several do', () => {
    const everything = entry({
      status: 'needs_reauthorization',
      unavailable_reason: 'Maintenance',
      workspace_enabled: false,
    });
    expect(connectorCardState({ ...everything, status: 'coming_soon' }, MEMBER).kind).toBe(
      'coming_soon'
    );
    // The server's reason wins over the workspace's switch.
    expect(connectorCardState(everything, MEMBER).kind).toBe('unavailable');
    // Off in the workspace wins over a sign-in that needs renewing.
    expect(connectorCardState({ ...everything, unavailable_reason: null }, MEMBER).kind).toBe(
      'workspace_off'
    );
    expect(
      connectorCardState({ ...everything, unavailable_reason: null, status: 'connected' }, MEMBER)
        .kind
    ).toBe('workspace_off');
  });
});

describe('what each person is told about a connector that cannot be used', () => {
  const OPERATOR: ConnectorViewer = { operator: true, administers: true, onThisComputer: false };
  const ADMIN: ConnectorViewer = { operator: false, administers: true, onThisComputer: false };
  const viewers = { operator: OPERATOR, admin: ADMIN, member: MEMBER };
  const notSetUp = entry({
    connectable: false,
    unavailable_reason: 'Example is not set up on this server.',
    unavailable_code: 'app_not_set_up',
  });
  const github = entry({
    slug: 'github',
    name: 'GitHub',
    connectable: false,
    unavailable_reason: "GitHub can't be used on this server.",
    unavailable_code: 'needs_https',
  });

  it('tells the operator to set the public address, and everyone else whom to ask', () => {
    const airtable = entry({
      slug: 'airtable',
      name: 'Airtable',
      connectable: false,
      unavailable_reason: "Airtable can't be connected on this server.",
      unavailable_code: 'needs_public_url',
    });
    expect(connectorCardState(airtable, OPERATOR).detail).toBe(
      "Airtable sends people back to this server's public address. Set GATEWAY_PUBLIC_URL, then restart Switch."
    );
    for (const viewer of [ADMIN, MEMBER])
      expect(connectorCardState(airtable, viewer)).toEqual({
        kind: 'unavailable',
        label: 'Unavailable',
        detail:
          "Airtable needs the server's public address. Ask whoever runs your Switch server to set it.",
        tone: 'muted',
        fix: null,
      });
  });

  it('offers the operator to set up an app that is not set up', () => {
    expect(connectorCardState(notSetUp, OPERATOR)).toEqual({
      kind: 'needs_setup',
      label: 'Needs setup',
      detail: 'Set up its app once, and everyone on this server can connect Example.',
      tone: 'muted',
      fix: 'set_up',
    });
  });

  it('tells everyone else who sets it up, without a button', () => {
    for (const viewer of [ADMIN, MEMBER])
      expect(connectorCardState(notSetUp, viewer)).toEqual({
        kind: 'unavailable',
        label: 'Unavailable',
        detail: 'Ask whoever runs your Switch server to set it up.',
        tone: 'muted',
        fix: null,
      });
  });

  it('offers nobody a fix for a service that cannot work on this server', () => {
    for (const viewer of Object.values(viewers))
      expect(connectorCardState(github, viewer)).toMatchObject({
        kind: 'unavailable',
        label: 'Unavailable',
        detail: "GitHub needs a server with an https address, so it can't work on this one.",
        fix: null,
      });
  });

  it("points at this computer's own GitHub sign-in where the server runs on it", () => {
    const here = { ...MEMBER, onThisComputer: true };
    expect(connectorCardState(github, here).detail).toBe(
      "GitHub needs a server with an https address, so it can't work on this one. Agents can use this computer's own GitHub sign-in (gh or git) instead."
    );
    // Only GitHub has a sign-in of its own on the computer to fall back on.
    expect(connectorCardState({ ...github, slug: 'example', name: 'Example' }, here).detail).toBe(
      "Example needs a server with an https address, so it can't work on this one."
    );
  });

  it('shows any other reason as the server words it, to everyone', () => {
    for (const code of ['switched_off', 'not_set_up', 'not_fully_set_up'] as const)
      for (const viewer of Object.values(viewers))
        expect(
          connectorCardState(
            entry({ unavailable_reason: 'Maintenance', unavailable_code: code }),
            viewer
          )
        ).toMatchObject({ kind: 'unavailable', detail: 'Maintenance', fix: null });
  });

  it('shows the reason as it is from a server that sends no code, guessing nothing', () => {
    const older = entry({
      connectable: false,
      unavailable_reason:
        'Example is not set up on this server. Ask whoever runs your Switch server to add it under Connectors in the Switch dashboard.',
    });
    for (const viewer of Object.values(viewers))
      expect(connectorCardState(older, viewer)).toMatchObject({
        kind: 'unavailable',
        detail: older.unavailable_reason,
        fix: null,
      });
  });

  it('offers workspace admins, and the operator, to turn on a service the workspace has off', () => {
    const off = entry({ workspace_enabled: false });
    for (const viewer of [OPERATOR, ADMIN])
      expect(connectorCardState(off, viewer)).toEqual({
        kind: 'workspace_off',
        label: 'Off in this workspace',
        detail: 'Turn it on so people in this workspace can connect it.',
        tone: 'muted',
        fix: 'turn_on',
      });
    expect(connectorCardState(off, MEMBER)).toMatchObject({
      detail: 'Ask a workspace admin to turn it on.',
      fix: null,
    });
  });

  it('puts the fix on the card in place of Connect, and nothing where there is none', () => {
    const quick = (item: ConnectionCatalogEntry, viewer: ConnectorViewer) =>
      cardQuickAction(item, connectorCardState(item, viewer));
    expect(quick(notSetUp, OPERATOR)).toBe('set_up');
    expect(quick(notSetUp, MEMBER)).toBeNull();
    expect(quick(github, OPERATOR)).toBeNull();
    expect(quick(entry({ workspace_enabled: false }), ADMIN)).toBe('turn_on');
    expect(quick(entry({ workspace_enabled: false }), MEMBER)).toBeNull();
    // A server's reason still wins over the workspace's switch, fix and all.
    expect(quick({ ...notSetUp, workspace_enabled: false }, OPERATOR)).toBe('set_up');
    expect(quick({ ...github, workspace_enabled: false }, ADMIN)).toBeNull();
  });

  it('takes Connect off the profile where nothing could be connected', () => {
    expect(profileConnectAction(notSetUp)).toBeNull();
    expect(profileConnectAction(github)).toBeNull();
    expect(profileConnectAction({ ...github, status: 'error' })).toBeNull();
    // Connectable where it cannot be granted: still offered.
    expect(
      profileConnectAction(
        entry({ unavailable_reason: 'Not fully set up.', unavailable_code: 'not_fully_set_up' })
      )
    ).toBe('connect');
  });

  it('offers no way to connect or replace a key Switch never hands to agents', () => {
    const key = entry({
      auth_type: 'api_key',
      unavailable_reason: 'Datadog keys do not expire.',
      unavailable_code: 'key_never_expires',
    });
    expect(profileConnectAction(key)).toBeNull();
    expect(profileConnectAction({ ...key, status: 'connected' })).toBeNull();
  });
});

describe('the Yours and Discover tabs', () => {
  const catalog = [
    entry({ slug: 'atlassian', name: 'Atlassian', category: 'Project management' }),
    entry({
      slug: 'datadog',
      name: 'Datadog',
      category: 'Observability',
      description: 'Monitors, logs and incidents.',
      status: 'connected',
    }),
    entry({ slug: 'github', name: 'GitHub', category: 'Source control', status: 'error' }),
    entry({
      slug: 'jira-ish',
      name: 'Linear',
      category: 'Project management',
      status: 'needs_reauthorization',
    }),
    entry({ slug: 'notion', name: 'Notion', category: 'Docs', status: 'coming_soon' }),
  ];
  const names = (list: ConnectionCatalogEntry[]) => list.map((item) => item.name);

  it('puts every connection the person has on Yours, working or not', () => {
    expect(names(connectorsInTab(catalog, 'yours', ''))).toEqual(['Datadog', 'GitHub', 'Linear']);
  });

  it('puts the whole catalog on Discover, connected services and coming soon included', () => {
    expect(names(connectorsInTab(catalog, 'discover', ''))).toEqual([
      'Atlassian',
      'Datadog',
      'GitHub',
      'Linear',
      'Notion',
    ]);
  });

  it('opens on Yours once the person has a connection, working or not, and on Discover before', () => {
    expect(defaultConnectorsTab(catalog)).toBe('yours');
    expect(defaultConnectorsTab([entry({ status: 'needs_reauthorization' })])).toBe('yours');
    expect(
      defaultConnectorsTab([entry({ status: 'not_connected' }), entry({ status: 'coming_soon' })])
    ).toBe('discover');
    expect(defaultConnectorsTab([])).toBe('discover');
  });

  it('searches within the tab by name, category or description', () => {
    expect(names(connectorsInTab(catalog, 'discover', 'project'))).toEqual(['Atlassian', 'Linear']);
    expect(names(connectorsInTab(catalog, 'yours', 'project'))).toEqual(['Linear']);
    expect(names(connectorsInTab(catalog, 'yours', 'atlas'))).toEqual([]);
    expect(names(connectorsInTab(catalog, 'discover', ' NOTION '))).toEqual(['Notion']);
    expect(names(connectorsInTab(catalog, 'discover', 'incidents'))).toEqual(['Datadog']);
  });
});

describe("a card's own control", () => {
  const quick = (overrides: Partial<ConnectionCatalogEntry>) => {
    const item = entry(overrides);
    return cardQuickAction(item, connectorCardState(item, MEMBER));
  };

  it('connects where the profile would offer Connect', () => {
    expect(quick({})).toBe('connect');
    // Connectable where it cannot be granted: still offered, as on the profile.
    expect(quick({ unavailable_reason: 'Not fully set up.' })).toBe('connect');
  });

  it('marks a connection only when the card shows it connected, never offering to disconnect', () => {
    expect(quick({ status: 'connected' })).toBe('connected');
    expect(quick({ status: 'connected', workspace_enabled: null })).toBe('connected');
  });

  it('shows the state, not the mark, for a connection that cannot be used', () => {
    expect(quick({ status: 'connected', workspace_enabled: false })).toBeNull();
    expect(quick({ status: 'connected', unavailable_reason: 'Not set up on this server.' })).toBe(
      null
    );
    expect(quick({ status: 'connected', unavailable_reason: 'Gone.', connectable: false })).toBe(
      null
    );
  });

  it('offers nothing it would be refused, or that needs the profile', () => {
    expect(quick({ connectable: false })).toBeNull();
    expect(quick({ workspace_enabled: false })).toBeNull();
    expect(quick({ status: 'coming_soon' })).toBeNull();
    expect(quick({ status: 'needs_reauthorization' })).toBeNull();
    expect(quick({ status: 'error' })).toBeNull();
  });
});

describe('the profile', () => {
  it('says who the connection is as, and what was allowed', () => {
    expect(connectedAsLine(entry())).toBeNull();
    expect(
      connectedAsLine(entry({ status: 'connected', external_identity: 'ada', consent: 'write' }))
    ).toBe('Connected as ada · Read and write');
    expect(
      connectedAsLine(entry({ status: 'connected', external_identity: 'ada', consent: 'read' }))
    ).toBe('Connected as ada · Read');
    expect(connectedAsLine(entry({ status: 'needs_reauthorization', consent: null }))).toBe(
      'Connected'
    );
    expect(
      connectedAsLine(
        entry({
          status: 'connected',
          auth_type: 'api_key',
          external_identity: 'Key · example.test',
        })
      )
    ).toBe('Connected with Key · example.test');
  });

  it('claims no access level for a key, and says what agents can do with one', () => {
    const key = entry({
      status: 'connected',
      auth_type: 'api_key',
      external_identity: 'Key · example.test',
      consent: 'write',
    });
    expect(connectedAsLine(key)).toBe('Connected with Key · example.test');
    expect(connectedAsLine({ ...key, external_identity: null })).toBe('Connected with your key');
    expect(keyAccessText(key)).toBe(
      "Whatever the key allows at Example. Switch can't read a key's scopes."
    );
    expect(keyAccessText(entry({ status: 'connected', consent: 'write' }))).toBeNull();
  });

  it('names the sign-in type and how long access lasts', () => {
    expect(signInLabel(entry())).toBe('Sign in at Example');
    expect(signInLabel(entry({ auth_type: 'api_key' }))).toBe('Key');
    expect(signInLabel(entry({ slug: 'github' }))).toBe('GitHub App');
    expect(tokenLifetimeLabel(entry({ token_lifetime: 3600 }))).toBe('1 hour');
    expect(tokenLifetimeLabel(entry({ token_lifetime: 28_800 }))).toBe('8 hours');
    expect(tokenLifetimeLabel(entry({ token_lifetime: 900 }))).toBe('15 minutes');
    expect(tokenLifetimeLabel(entry({ token_lifetime: 172_800 }))).toBe('2 days');
    expect(tokenLifetimeLabel(entry({ token_lifetime: null }))).toBe('Not stated');
    expect(tokenLifetimeLabel(entry({ auth_type: 'api_key' }))).toBe(
      "The key itself, which doesn't expire"
    );
  });

  it('offers connecting, signing in again, or replacing a key', () => {
    expect(profileConnectAction(entry())).toBe('connect');
    expect(profileConnectAction(entry({ status: 'needs_reauthorization' }))).toBe('reconnect');
    expect(profileConnectAction(entry({ status: 'error' }))).toBe('reconnect');
    expect(profileConnectAction(entry({ status: 'connected' }))).toBeNull();
    expect(profileConnectAction(entry({ slug: 'github', status: 'connected' }))).toBeNull();
    expect(profileConnectAction(entry({ status: 'connected', auth_type: 'api_key' }))).toBe(
      'replace'
    );
    expect(profileConnectAction(entry({ status: 'not_connected', auth_type: 'api_key' }))).toBe(
      'connect'
    );
    expect(profileConnectAction(entry({ status: 'coming_soon' }))).toBeNull();
    // Connectable where it cannot be granted: the server's reason does not hide Connect.
    expect(
      profileConnectAction(entry({ slug: 'github', unavailable_reason: 'Not fully set up.' }))
    ).toBe('connect');
    // Off in the workspace: the notice, not a button that would be refused.
    expect(profileConnectAction(entry({ workspace_enabled: false }))).toBeNull();
    expect(
      profileConnectAction(entry({ workspace_enabled: false, status: 'needs_reauthorization' }))
    ).toBeNull();
  });

  it('tells a member who can switch it on, and offers an admin the switch', () => {
    const off = entry({ workspace_enabled: false });
    expect(workspaceOffNotice(off, false)).toEqual({
      text: 'Not enabled in this workspace. Ask a workspace admin.',
      canEnable: false,
    });
    expect(workspaceOffNotice(off, true)).toEqual({
      text: 'Example is switched off for this workspace.',
      canEnable: true,
    });
    expect(workspaceOffNotice(entry(), true)).toBeNull();
    // No workspace layer on this server: nothing to say.
    expect(workspaceOffNotice(entry({ workspace_enabled: null }), false)).toBeNull();
  });
});

describe('the agents on a connector page', () => {
  const agents = [
    { agent_id: 'm2', name: 'M2', granted: false, addressing_open: true },
    { agent_id: 'm1', name: 'M1', granted: false, addressing_open: false },
    { agent_id: 'm3', name: 'M3', granted: true, addressing_open: true },
  ];

  it('can be added from the page for a service a grant switches on, and for GitHub', () => {
    expect(offersAddAgent(entry({ pass_through: true }))).toBe(true);
    expect(offersAddAgent(entry({ pass_through: false }))).toBe(false);
    expect(offersAddAgent(entry({ slug: 'github', pass_through: false }))).toBe(true);
  });

  it('starts a GitHub choice at the first account with nothing chosen, read only', () => {
    expect(emptyGitHubGrant(undefined)).toEqual({
      installationId: null,
      repositoryIds: [],
      access: 'read',
    });
    const github = {
      status: 'connected' as const,
      login: 'ada',
      install_url: 'https://example.test',
      installations: [
        {
          id: 7,
          account: 'ada',
          repositories: [
            { id: 1, name: 'ada/one' },
            { id: 2, name: 'ada/two' },
          ],
        },
        { id: 8, account: 'org', repositories: [{ id: 3, name: 'org/three' }] },
      ],
    };
    const empty = emptyGitHubGrant(github);
    expect(empty).toEqual({ installationId: 7, repositoryIds: [], access: 'read' });
    // Nothing to send until a repository is chosen.
    expect(githubGrantResources(empty)).toBeNull();
    expect(githubChoiceSummary(github, empty)).toBeNull();

    const one = withRepository(empty, 2);
    expect(withRepository(one, 2)).toBe(one);
    expect(githubGrantResources(one)).toEqual({ installation_id: 7, repository_ids: [2] });
    const all = withEveryRepository(github, one);
    expect(all.repositoryIds).toEqual([2, 1]);
    expect(withoutRepository(all, 2).repositoryIds).toEqual([1]);
    // Another account starts over: its repositories are different ones.
    expect(withInstallation(all, 8)).toEqual({
      installationId: 8,
      repositoryIds: [],
      access: 'read',
    });
  });

  it('says a GitHub choice in a sentence, naming the account only among several', () => {
    const one = {
      status: 'connected' as const,
      login: 'ada',
      install_url: 'https://example.test',
      installations: [
        {
          id: 7,
          account: 'ada',
          repositories: [
            { id: 1, name: 'ada/one' },
            { id: 2, name: 'ada/two' },
          ],
        },
      ],
    };
    const two = {
      ...one,
      installations: [...one.installations, { id: 8, account: 'org', repositories: [] }],
    };
    expect(
      githubChoiceSummary(one, { installationId: 7, repositoryIds: [1], access: 'read' })
    ).toBe('read access to 1 repository');
    expect(
      githubChoiceSummary(one, { installationId: 7, repositoryIds: [1, 2], access: 'write' })
    ).toBe('read and push access to 2 repositories');
    expect(
      githubChoiceSummary(two, { installationId: 7, repositoryIds: [1], access: 'read' })
    ).toBe('read access to 1 repository under ada');
  });

  it('counts repositories across accounts and offers choosing, then changing, them', () => {
    const none = {
      status: 'connected' as const,
      login: 'ada',
      install_url: 'https://example.test',
      installations: [{ id: 7, account: 'ada', repositories: [] }],
    };
    expect(repositoriesSummary(none)).toBe('0 repositories');
    expect(repositoriesActionLabel(none)).toBe('Choose repositories');
    const some = {
      ...none,
      installations: [
        { id: 7, account: 'ada', repositories: [{ id: 1, name: 'ada/one' }] },
        {
          id: 8,
          account: 'org',
          repositories: [
            { id: 2, name: 'org/two' },
            { id: 3, name: 'org/three' },
          ],
        },
      ],
    };
    expect(repositoriesSummary(some)).toBe('3 repositories across 2 accounts');
    expect(repositoriesActionLabel(some)).toBe('Change repositories');
  });

  it('counts the agents using it beside the heading', () => {
    expect(agentsSummary(0)).toBe('0 agents');
    expect(agentsSummary(1)).toBe('1 agent');
    expect(agentsSummary(3)).toBe('3 agents');
  });

  it('offers the agents without the service, narrowed by the search', () => {
    expect(addableAgents(agents, '').map((agent) => agent.agent_id)).toEqual(['m2', 'm1']);
    expect(addableAgents(agents, ' m1 ').map((agent) => agent.agent_id)).toEqual(['m1']);
    expect(addableAgents(agents, 'M3')).toEqual([]);
    expect(OPEN_AGENT_NOTE).toBe('Others can address it; it would act as you.');
  });

  it("sends the person to the agent's Connectors where the server cannot list agents", () => {
    expect(agentsUnlistedText('Example')).toBe(
      "This server can't list your agents here. Turn Example on for an agent from the agent's Connectors."
    );
  });

  it('says so when the person has no agents yet', () => {
    expect(noAgentsText('Example')).toBe(
      "You have no agents in this workspace yet. Once you add one, turn Example on for it from the agent's Connectors."
    );
  });
});

/** A refusal as it reaches the renderer from the gateway. */
function refusal(status: number, retryable?: boolean): RpcError {
  return new RpcError(
    serializeRpcError(
      Object.assign(new Error(`Switch gateway returned ${status}`), {
        name: 'GatewayError',
        kind: 'http',
        status,
        detail: 'Refused.',
        ...(retryable === undefined ? {} : { retryable }),
      })
    )
  );
}

describe('the sign-in flow', () => {
  const waiting: ConnectFlowState = {
    ...initialConnectFlow(false),
    flowId: 'flow-1',
    flow: { status: 'pending', account: null, error: null, warning: null },
  };
  const run = (state: ConnectFlowState, ...events: Parameters<typeof connectFlowReducer>[1][]) =>
    events.reduce(connectFlowReducer, state);

  it('cannot be closed while waiting for the browser, or mid-call', () => {
    expect(canCloseConnectFlow(initialConnectFlow(false))).toBe(true);
    expect(canCloseConnectFlow(waiting)).toBe(false);
    expect(canCloseConnectFlow(run(initialConnectFlow(false), { type: 'act' }))).toBe(false);
  });

  it('counts a cancel answered 410 as cancelled, not as an error', () => {
    expect(
      run(waiting, { type: 'act' }, { type: 'cancel_failed', cause: refusal(410), error: 'Gone.' })
    ).toMatchObject({ flowId: null, flow: null, busy: false, error: null });
    expect(
      run(waiting, { type: 'act' }, { type: 'cancel_failed', cause: refusal(503), error: 'Down.' })
    ).toMatchObject({ flowId: 'flow-1', error: 'Down.' });
  });

  it("says why a sign-in failed, in the server's words where it has them, and lets the dialog close", () => {
    const failed = run(waiting, {
      type: 'polled',
      flow: { status: 'failed', account: null, error: null, warning: null },
      failure: 'Signing in failed.',
    });
    expect(failed.error).toBe('Signing in failed.');
    expect(failed.flowId).toBe('flow-1');
    expect(canCloseConnectFlow(failed)).toBe(true);
    const refused = run(waiting, {
      type: 'polled',
      flow: { status: 'failed', account: null, error: 'Already linked elsewhere.', warning: null },
      failure: 'Signing in failed.',
    });
    expect(refused.error).toBe('Already linked elsewhere.');
  });

  it('is connected, with the warning, once the server has kept the account', () => {
    const after = run(waiting, { type: 'connected', warning: 'Access stays a while.' });
    expect(after).toMatchObject({
      connected: true,
      flowId: null,
      flow: null,
      busy: false,
      error: null,
      warning: 'Access stays a while.',
    });
    expect(canCloseConnectFlow(after)).toBe(true);
  });
});

describe('the disconnect dialog', () => {
  it('leads with how many agents lose the service, then names them', () => {
    expect(disconnectCopy(entry({ name: 'Atlassian' }), ['m1-cc']).lines[0]).toBe(
      'm1-cc loses Atlassian.'
    );
    expect(disconnectCopy(entry(), ['M1', 'M3']).lines[0]).toBe(
      '2 agents lose Example: M1 and M3. Disconnecting removes their access.'
    );
    expect(
      disconnectCopy(entry({ name: 'Atlassian' }), ['m1-cc', 'm3-oc', 'm4', 'test']).lines[0]
    ).toBe(
      '4 agents lose Atlassian: m1-cc, m3-oc, m4 and test. Disconnecting removes their access.'
    );
  });

  it('names at most four agents, and counts the rest', () => {
    expect(disconnectCopy(entry(), ['A', 'B', 'C', 'D', 'E']).lines[0]).toBe(
      '5 agents lose Example: A, B, C, D and 1 more. Disconnecting removes their access.'
    );
    expect(disconnectCopy(entry(), ['A', 'B', 'C', 'D', 'E', 'F', 'G']).lines[0]).toBe(
      '7 agents lose Example: A, B, C, D and 3 more. Disconnecting removes their access.'
    );
  });

  it('says nobody loses it when no agent uses it', () => {
    expect(disconnectCopy(entry(), []).lines[0]).toBe('None of your agents use Example.');
    expect(disconnectCopy(entry(), []).title).toBe('Disconnect Example?');
  });

  it('says every agent loses it where the server cannot say which', () => {
    expect(disconnectCopy(entry(), null).lines[0]).toBe(
      "Disconnecting removes every agent's access to Example."
    );
  });

  it('adds that the key cannot be revoked only for a key', () => {
    const note = "Switch can't revoke this key at Example; delete it there.";
    expect(disconnectCopy(entry({ auth_type: 'api_key' }), ['M1']).lines).toContain(note);
    expect(disconnectCopy(entry({ auth_type: 'oauth' }), ['M1']).lines).not.toContain(note);
  });
});

describe('an admin switching a service off', () => {
  const service = { name: 'Example', connected_members: 0, granted_agents: 0 };

  it('asks first when anyone is connected or any agent uses it, naming both counts', () => {
    expect(switchOffConfirmation({ ...service, connected_members: 3, granted_agents: 5 })).toEqual({
      title: 'Switch Example off for this workspace?',
      description:
        '3 members are connected and 5 agents use it. Their sessions lose it within a minute.',
    });
    expect(
      switchOffConfirmation({ ...service, connected_members: 1, granted_agents: 0 })?.description
    ).toBe('1 member is connected and 0 agents use it. Their sessions lose it within a minute.');
    expect(
      switchOffConfirmation({ ...service, connected_members: 0, granted_agents: 1 })?.description
    ).toBe('0 members are connected and 1 agent uses it. Their sessions lose it within a minute.');
  });

  it('does not ask when nobody is connected and no agent uses it', () => {
    expect(switchOffConfirmation(service)).toBeNull();
  });

  it('says who last switched it, or that nobody has', () => {
    const at = (iso: string) => `at ${iso}`;
    expect(
      workspaceSwitchNote({ enabled: true, updated_by_name: null, updated_at: null }, at)
    ).toBe('On by default.');
    expect(
      workspaceSwitchNote({ enabled: false, updated_by_name: null, updated_at: null }, at)
    ).toBe('Off by default.');
    expect(
      workspaceSwitchNote({ enabled: false, updated_by_name: 'Ada', updated_at: 'T' }, at)
    ).toBe('Switched off by Ada, at T.');
  });
});

describe('with the service_connections flag off', () => {
  const flags = (on: boolean): ServerFeatureFlags => ({
    serverId: 'server',
    flags: { ...allFeatureFlagsOff(), service_connections: on },
    fetchedAt: 1,
    error: null,
  });

  it('leaves Connectors and Admin out of the nav', () => {
    const shown = workspaceNavViews({
      managed: false,
      serviceConnections: false,
      administers: true,
    });
    expect(shown).not.toContain('connectors');
    expect(shown).not.toContain('admin');
    expect(
      workspaceNavViews({ managed: true, serviceConnections: true, administers: true })
    ).toEqual(['server', 'serverAgents', 'serverRooms', 'connectors', 'templates', 'admin']);
  });

  it('shows Admin only to whoever administers the workspace or runs its server', () => {
    expect(
      workspaceNavViews({ managed: false, serviceConnections: true, administers: false })
    ).toEqual(['server', 'serverAgents', 'serverRooms', 'connectors', 'templates']);
    // The server's status lives under Admin, for whoever runs it, flag or role aside.
    expect(
      workspaceNavViews({ managed: true, serviceConnections: false, administers: false })
    ).toEqual(['server', 'serverAgents', 'serverRooms', 'templates', 'admin']);
  });

  it('opens Admin on its sections, or on the server’s status where there are none to use', () => {
    expect(adminNavTarget({ serviceConnections: true, administers: true, frozen: false })).toBe(
      'admin'
    );
    expect(adminNavTarget({ serviceConnections: false, administers: true, frozen: false })).toBe(
      'managedServer'
    );
    expect(adminNavTarget({ serviceConnections: true, administers: false, frozen: false })).toBe(
      'managedServer'
    );
    // While the server can't answer, its status is the only entry that works.
    expect(adminNavTarget({ serviceConnections: true, administers: true, frozen: true })).toBe(
      'managedServer'
    );
  });

  it('has no page to show, rather than an empty one', () => {
    expect(connectorsPageAccess(flags(false))).toBe('absent');
    expect(connectorsPageAccess({ ...flags(false), fetchedAt: null, error: 'down' })).toBe(
      'absent'
    );
    expect(connectorsPageAccess(null)).toBe('loading');
    expect(
      connectorsPageAccess({ ...flags(false), fetchedAt: null, error: FLAGS_NOT_READ_YET })
    ).toBe('loading');
    expect(connectorsPageAccess(flags(true))).toBe('shown');
  });
});
