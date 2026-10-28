import type { AgentRef, RoomDetail, SwitchClient } from '../clients/switch-client.ts';
import type { NameScope } from '../core/run.ts';
import type { Fixtures } from '../fixtures/fixtures.ts';
import type { ServerSurface } from '../gate/gate.ts';
import { isHtml } from './session-required.ts';

/**
 * A check derived from the surface snapshot rather than written per route: a
 * member of one workspace is refused another workspace's resources.
 *
 * A second workspace is made with a room and an agent in it, by a second
 * deployment admin (an operator may create workspaces without a sign-up
 * allowance). Then a plain member of the first workspace calls every session
 * route whose path parameters all name something the second workspace has
 * (its id, the room, the agent, the agent's name) with the second workspace's
 * values, and no body.
 *
 * The prober is a plain member, not the harness admin, because a deployment
 * admin is an operator and may cross workspaces by design.
 *
 * - 403 or 404 is the answer wanted.
 * - 2xx or 3xx is a leak: the route served or changed another workspace's
 *   resource. 5xx, or an HTML page, is a failure too.
 * - Anything else (400, 405, 409, 422: mostly a body the probe did not send)
 *   says nothing about isolation either way. Those are counted and listed,
 *   not failed: a validation error answered before the tenant is checked is
 *   not a leak.
 *
 * Workspaces and users cannot be deleted, so this runs only on a stack that
 * is thrown away after the run. The room and the agent are removed.
 */

export interface CrossTenantProbe {
  /** Answered 403 or 404. */
  refused: number;
  /** Routes with a path parameter the second workspace has nothing for. */
  unprobed: number;
  /** Answered something that is neither a refusal nor a leak, with what. */
  inconclusive: string[];
  /** Served, changed or broke on another workspace's resource, with what. */
  wrong: string[];
  /** The route each request id was sent to, to name the route behind a server log line. */
  routeOf: Map<string, string>;
}

export interface OtherTenant {
  tenantId: string;
  room: RoomDetail;
  agent: AgentRef;
}

/**
 * Make the second workspace, its room and its agent, and the plain member who
 * probes it. The room and the agent are deferred to `fixtures` as each is
 * made, so a failure part way still removes what was made.
 */
export async function otherTenantAndProber(
  admin: SwitchClient,
  names: NameScope,
  fixtures: Fixtures
): Promise<{ other: OtherTenant; prober: SwitchClient }> {
  const password = `e2e-${names.runId}-${crypto.randomUUID()}`;
  const ownerEmail = `${names.name('owner')}@e2e.invalid`;
  const proberEmail = `${names.name('prober')}@e2e.invalid`;
  await admin.createUser({
    name: 'E2E workspace owner',
    email: ownerEmail,
    password,
    role: 'admin',
  });
  await admin.createUser({ name: 'E2E prober', email: proberEmail, password, role: 'user' });
  const owner = admin.as(ownerEmail, password);
  const tenantId = await owner.createTenant(names.name('space'));
  const agent = await owner.registerAgentAsUser({
    name: names.name('theirs'),
    description: `Switch end-to-end harness, another workspace's agent (run ${names.runId}).`,
  });
  fixtures.defer(`the other workspace's agent ${agent.name}`, () =>
    owner.deleteAgentByName(agent.name)
  );
  const room = await owner.createRoom({
    name: names.name('their-room'),
    description: `Switch end-to-end harness, another workspace's room (run ${names.runId}).`,
    bridgeId: null,
    agentNames: [agent.name],
    userNames: [],
  });
  fixtures.defer(`the other workspace's room ${room.name} (${room.id})`, () =>
    owner.deleteRoom(room.id)
  );
  return { other: { tenantId, room, agent }, prober: admin.as(proberEmail, password) };
}

/** 0 for a read, 1 for a write, 2 for a delete; ties keep the snapshot's order. */
export function probeOrder(route: string): number {
  const method = route.split(' ', 1)[0];
  if (method === 'GET' || method === 'HEAD') return 0;
  return method === 'DELETE' ? 2 : 1;
}

export function crossTenantPath(
  route: string,
  other: OtherTenant
): { method: string; path: string } | null {
  const [method, template] = route.split(' ', 2) as [string, string];
  const values: Record<string, string> = {
    tenant_id: other.tenantId,
    room_id: other.room.id,
    agent_id: other.agent.id,
    agent_name: other.agent.name,
  };
  let complete = true;
  const path = template.replace(/\{([^}]+)\}/g, (_, param: string) => {
    const value = values[param];
    if (value === undefined) {
      complete = false;
      return '';
    }
    return encodeURIComponent(value);
  });
  return complete && path !== template ? { method, path } : null;
}

export async function probeCrossTenant(
  prober: SwitchClient,
  surface: ServerSurface,
  enabledFlags: ReadonlySet<string>,
  other: OtherTenant
): Promise<CrossTenantProbe> {
  const result: CrossTenantProbe = {
    refused: 0,
    unprobed: 0,
    inconclusive: [],
    wrong: [],
    routeOf: new Map(),
  };
  // Reads, then writes, then deletes: a write that leaked could archive or
  // move the resource, and a delete that leaked removes it, either way turning
  // every later probe of it into a 404 that looks like a refusal.
  const routes = surface.gatewayRoutes
    .filter(
      ({ auth, route, flags }) =>
        auth === 'session' && /\{/.test(route) && flags.every((f) => enabledFlags.has(f))
    )
    .sort((a, b) => probeOrder(a.route) - probeOrder(b.route));
  for (const { route } of routes) {
    const target = crossTenantPath(route, other);
    if (target === null) {
      result.unprobed += 1;
      continue;
    }
    const { status, contentType, requestId } = await prober.statusWithSession(
      target.method,
      target.path
    );
    if (requestId !== null) result.routeOf.set(requestId, route);
    const answered = `${route} -> ${status} ${contentType || '(no content type)'}`;
    if (isHtml(contentType) || status < 400 || status >= 500) result.wrong.push(answered);
    else if (status === 403 || status === 404) result.refused += 1;
    else result.inconclusive.push(answered);
  }
  return result;
}
