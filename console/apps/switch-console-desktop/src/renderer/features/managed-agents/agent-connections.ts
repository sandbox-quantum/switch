import { isYours } from '@renderer/features/connectors/connectors-catalog';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import { ownerOnlyPolicy } from '@shared/core/switch-servers/owner-policy';
import type { ServiceGrant, ServiceGrants } from '@shared/core/switch-servers/service-grants';

/**
 * One card on an agent's Connectors tab. GitHub's grant names repositories;
 * an on/off service hands the agent the owner's own token; `other` is a grant
 * on a service this page has nothing to change on, which can only be removed.
 */
export type AgentConnectionCard = {
  slug: string;
  name: string;
  kind: 'github' | 'on-off' | 'other';
  /** Its catalog entry; null for a grant whose service the catalog no longer lists. */
  service: ConnectionCatalogEntry | null;
  grant: ServiceGrant | null;
};

const GITHUB = 'github';

/** A service this page can grant: GitHub, or one whose agents use the owner's own token. */
function grantable(service: ConnectionCatalogEntry): boolean {
  return (
    service.enabled &&
    service.status !== 'coming_soon' &&
    (service.slug === GITHUB || service.pass_through)
  );
}

/**
 * The cards on an agent's Connectors tab, in catalog order: every service
 * the owner has connected that a grant can be made on, and every grant the
 * agent holds, whatever its connection's state, so a grant is never hidden.
 * `unconnected` names the grantable services the owner has not connected.
 */
export function agentConnectionCards(
  services: readonly ConnectionCatalogEntry[],
  grants: readonly ServiceGrant[]
): { cards: AgentConnectionCard[]; unconnected: string[] } {
  const grantOf = (slug: string) => grants.find((grant) => grant.service === slug) ?? null;
  const cards: AgentConnectionCard[] = [];
  const unconnected: string[] = [];
  for (const service of services) {
    const grant = grantOf(service.slug);
    const offered = grantable(service);
    if (grant === null && !offered) continue;
    if (grant === null && service.status === 'not_connected') {
      unconnected.push(service.name);
      continue;
    }
    cards.push({
      slug: service.slug,
      name: service.name,
      kind: !offered ? 'other' : service.slug === GITHUB ? 'github' : 'on-off',
      service,
      grant,
    });
  }
  for (const grant of grants) {
    if (services.some((service) => service.slug === grant.service)) continue;
    cards.push({ slug: grant.service, name: grant.name, kind: 'other', service: null, grant });
  }
  return { cards, unconnected };
}

/** The card's badge: what the agent has of the service now. */
export function connectionCardStatus(card: AgentConnectionCard): string {
  if (card.grant === null) return 'Off';
  if (card.kind === 'on-off') return 'On';
  return card.grant.access === 'write' ? 'Read and push' : 'Read';
}

/**
 * The card's one line: what the grant lets the agent do, or why it cannot be
 * turned on, or what the service is.
 */
export function connectionCardDetail(card: AgentConnectionCard): string {
  if (card.grant) return card.grant.summary;
  const { service } = card;
  if (service === null) return '';
  if (service.unavailable_reason !== null) return service.unavailable_reason;
  if (service.status === 'needs_reauthorization' || service.status === 'error')
    return `Your ${service.name} connection needs reconnecting. Reconnect it from Connectors.`;
  return service.description;
}

/** Whether the owner has not connected anything yet, working or not. */
export function noConnectorsSetUp(services: readonly ConnectionCatalogEntry[]): boolean {
  return !services.some(isYours);
}

/** The note under the cards naming the services not connected yet; null when there are none. */
export function unconnectedNote(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const them = names.length === 1 ? 'it' : 'them';
  return `Not connected: ${names.join(', ')}. Connect ${them} from Connectors to turn ${them} on here.`;
}

/** Whether to warn that anyone who can address the agent can use its grants. */
export function showsOwnerOnlyWarning(grants: ServiceGrants): boolean {
  return grants.addressing_open && grants.grants.length > 0;
}

/** The warning shown with {@link showsOwnerOnlyWarning}. */
export function ownerOnlyWarningText(label: string): string {
  return `Anyone who can address ${label} can have it use these grants. Owner-only stops that: only you can address it. It still reads what others write in shared rooms and posts results there.`;
}

/** What "Make owner-only" asks the server for: its owner alone, none of the owner's agents. */
export function ownerOnlyRequest(workspaceId: string, agentId: string) {
  return { workspaceId, agentId, policy: ownerOnlyPolicy() };
}
