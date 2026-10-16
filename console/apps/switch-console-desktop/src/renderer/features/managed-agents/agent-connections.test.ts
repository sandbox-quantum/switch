import { describe, expect, it } from 'vitest';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import type { ServiceGrant } from '@shared/core/switch-servers/service-grants';
import {
  agentConnectionCards,
  connectionCardDetail,
  connectionCardStatus,
  ownerOnlyRequest,
  ownerOnlyWarningText,
  showsOwnerOnlyWarning,
  unconnectedNote,
} from './agent-connections';

function service(
  slug: string,
  overrides: Partial<ConnectionCatalogEntry> = {}
): ConnectionCatalogEntry {
  return {
    slug,
    name: slug[0].toUpperCase() + slug.slice(1),
    category: 'Tools',
    description: `What ${slug} is.`,
    enabled: true,
    auth_type: 'oauth',
    connectable: true,
    status: 'connected',
    unavailable_reason: null,
    pass_through: true,
    token_lifetime: null,
    loopback_ports: null,
    key: null,
    external_identity: null,
    workspace_enabled: null,
    consent: null,
    ...overrides,
  };
}

function grant(slug: string, overrides: Partial<ServiceGrant> = {}): ServiceGrant {
  return {
    service: slug,
    name: slug[0].toUpperCase() + slug.slice(1),
    access: 'read',
    resources: {},
    summary: `Uses your ${slug}.`,
    ...overrides,
  };
}

const slugs = (services: ConnectionCatalogEntry[], grants: ServiceGrant[]) =>
  agentConnectionCards(services, grants).cards.map((card) => [card.slug, card.kind]);

describe("an agent's connection cards", () => {
  it('has a card for each service you connected, GitHub with its repo picker and the rest on/off', () => {
    expect(
      slugs(
        [service('github', { pass_through: false }), service('atlassian'), service('datadog')],
        []
      )
    ).toEqual([
      ['github', 'github'],
      ['atlassian', 'on-off'],
      ['datadog', 'on-off'],
    ]);
  });

  it('keeps a card for a connection that needs reconnecting', () => {
    expect(slugs([service('atlassian', { status: 'needs_reauthorization' })], [])).toEqual([
      ['atlassian', 'on-off'],
    ]);
  });

  it('names the services you have not connected instead of giving them cards', () => {
    const { cards, unconnected } = agentConnectionCards(
      [service('atlassian'), service('datadog', { status: 'not_connected' })],
      []
    );
    expect(cards.map((card) => card.slug)).toEqual(['atlassian']);
    expect(unconnected).toEqual(['Datadog']);
  });

  it('leaves out coming-soon and switched-off placeholders, and services nothing here can grant', () => {
    const { cards, unconnected } = agentConnectionCards(
      [
        service('notion', { status: 'coming_soon' }),
        service('linear', { enabled: false, status: 'not_connected' }),
        service('gitlab', { pass_through: false }),
      ],
      []
    );
    expect(cards).toEqual([]);
    expect(unconnected).toEqual([]);
  });

  it('never hides a grant: one on a disconnected or unlisted service still has a card to remove it', () => {
    expect(
      slugs(
        [
          service('datadog', { status: 'not_connected' }),
          service('gitlab', { pass_through: false }),
        ],
        [grant('datadog'), grant('gitlab'), grant('retired')]
      )
    ).toEqual([
      ['datadog', 'on-off'],
      ['gitlab', 'other'],
      ['retired', 'other'],
    ]);
  });

  it('shows what the agent has: on or off, and the access level for GitHub', () => {
    const [github, atlassian, datadog] = agentConnectionCards(
      [service('github', { pass_through: false }), service('atlassian'), service('datadog')],
      [grant('github', { access: 'write' }), grant('atlassian')]
    ).cards;
    expect(connectionCardStatus(github)).toBe('Read and push');
    expect(connectionCardStatus(atlassian)).toBe('On');
    expect(connectionCardStatus(datadog)).toBe('Off');
  });

  it("says what a grant does, else why it can't be turned on, else what the service is", () => {
    const [granted, unavailable, stale, plain] = agentConnectionCards(
      [
        service('atlassian'),
        service('datadog', { unavailable_reason: 'Maintenance' }),
        service('google', { status: 'error' }),
        service('box'),
      ],
      [grant('atlassian')]
    ).cards;
    expect(connectionCardDetail(granted)).toBe('Uses your atlassian.');
    expect(connectionCardDetail(unavailable)).toBe('Maintenance');
    expect(connectionCardDetail(stale)).toBe(
      'Your Google connection needs reconnecting. Reconnect it from Connectors.'
    );
    expect(connectionCardDetail(plain)).toBe('What box is.');
  });
});

describe('the note naming unconnected services', () => {
  it('sends them to Connectors', () => {
    expect(unconnectedNote(['Datadog'])).toBe(
      'Not connected: Datadog. Connect it from Connectors to turn it on here.'
    );
    expect(unconnectedNote(['Atlassian', 'Datadog'])).toBe(
      'Not connected: Atlassian, Datadog. Connect them from Connectors to turn them on here.'
    );
  });

  it('is absent when everything is connected', () => {
    expect(unconnectedNote([])).toBeNull();
  });
});

describe('the owner-only warning', () => {
  it('shows for an open agent that holds a grant', () => {
    expect(showsOwnerOnlyWarning({ addressing_open: true, grants: [grant('datadog')] })).toBe(true);
  });

  it('does not show for an owner-only agent, or an open one with nothing granted', () => {
    expect(showsOwnerOnlyWarning({ addressing_open: false, grants: [grant('datadog')] })).toBe(
      false
    );
    expect(showsOwnerOnlyWarning({ addressing_open: true, grants: [] })).toBe(false);
  });

  it('says owner-only means only you can address it, and what it still does in shared rooms', () => {
    expect(ownerOnlyWarningText('m2')).toBe(
      'Anyone who can address m2 can have it use these grants. Owner-only stops that: only you can address it. It still reads what others write in shared rooms and posts results there.'
    );
  });

  it("makes the agent its owner's alone, not reachable through the owner's other agents", () => {
    const request = ownerOnlyRequest('workspace', 'agent');
    expect(request).toMatchObject({ workspaceId: 'workspace', agentId: 'agent' });
    expect(request.policy.rules).toHaveLength(1);
    expect(request.policy.rules[0]).toMatchObject({ owner: true, owner_agents: false, agents: [] });
  });
});
