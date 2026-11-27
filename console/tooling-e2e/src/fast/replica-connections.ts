import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { otherThan, replicaOf, type HeldConnection, type ReplicaId, type Replicas } from '../clients/replicas.ts';
import { type HeldSocket, SocketRefused, type SwitchClient } from '../clients/switch-client.ts';
import type { FastContext, FastScenario } from './scenario.ts';

/**
 * Process faults on a two-replica stack (`just e2e-fast --replicas 2`) for
 * the connections clients hold, rather than the work the replicas run: the
 * replica holding an agent's connection socket is crashed, and what every
 * replica says about the agent must follow the holder's lease.
 *
 * Every bound is derived from the product's own timers, read from the
 * server's code by `properties/history/ownership.py`.
 */

/** Slack on every deadline derived from the timers: a poll, a request, a slow CI runner. */
const MARGIN_MS = 15_000;
/**
 * Reads in a row that must agree before a status counts as every replica's:
 * HAProxy deals requests round robin, and each replica answers from its own
 * copy of the connections.
 */
const AGREEING_READS = 4;

/** Wait until `agentId` reads `status` in the room on `AGREEING_READS` reads in a row. */
async function waitForStatus(
  switchClient: SwitchClient,
  roomId: string,
  agentId: string,
  status: (read: string | null) => boolean,
  what: string,
  sinceMs: number,
  deadlineMs: number
): Promise<string | null> {
  let agreeing = 0;
  let last: string | null = null;
  while (Date.now() - sinceMs < deadlineMs) {
    last = await switchClient.agentStatusInRoom(roomId, agentId);
    agreeing = status(last) ? agreeing + 1 : 0;
    if (agreeing >= AGREEING_READS) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the agent did not read ${what} within ${deadlineMs}ms; it last read ${last}`);
}

/** The replica holding connection `connectionId`, by its row. */
async function connectionHolder(replicas: Replicas, connectionId: string): Promise<{ row: HeldConnection; replica: ReplicaId }> {
  const ownership = await replicas.ownership('bridge');
  const row = ownership.agentConnections.find((connection) => connection.id === connectionId);
  if (row === undefined) {
    throw new Error(
      `no open row for connection ${connectionId}; open rows: ${JSON.stringify(ownership.agentConnections)}`
    );
  }
  const replica = replicaOf(row.processId);
  if (replica === null) throw new Error(`connection ${connectionId} is held by ${row.processId}, which names no replica`);
  return { row, replica };
}

/**
 * An agent's connection socket held by a replica that crashes. The socket
 * claims the room, so the agent reads `live` there on both replicas; once
 * its holder is killed, the survivor must read it offline within the
 * holder's lease and one lease watch, and live again once the agent
 * reconnects, with the same connection id, through the survivor.
 *
 * @property presence.online-iff-lease
 */
export const agentConnectionHolderKilled: FastScenario = {
  header: {
    id: 'replica-agent-connection-holder-killed',
    covers: ['GET /agents/{agent_id}/connection/ws', 'GET /gateway/rooms/{room_id}'],
    lane: 'fast',
    environments: ['ephemeral'],
    owner: 'platform',
    requires: ['replicas'],
  },
  async run({ fixtures, switchClient, replicas, log }) {
    const agent = await fixtures.agent('presence');
    const room = await fixtures.internalRoom('room', [agent]);
    const connectionId = randomUUID();
    const isLive = (read: string | null) => read === 'live';

    const first = await switchClient.openAgentSocket(agent, connectionId, [room.id]);
    try {
      await waitForStatus(switchClient, room.id, agent.id, isLive, 'live on both replicas', Date.now(), 30_000);
      const { row, replica: holder } = await connectionHolder(replicas!, connectionId);
      const survivor = otherThan(holder);
      log(`connection ${connectionId} is held by replica ${holder} (${row.processId}); the agent reads live`);

      const timers = (await replicas!.ownership('bridge')).timers;
      const faultAt = Date.now();
      await replicas!.stop(holder, 'SIGKILL');
      await replicas!.waitForRotation(holder, 'DOWN', 10_000);

      const offlineMs = (timers.leaseTtl + timers.watchSeconds) * 1000 + MARGIN_MS;
      const offline = await waitForStatus(
        switchClient,
        room.id,
        agent.id,
        (read) => !isLive(read),
        `offline on replica ${survivor}`,
        faultAt,
        offlineMs
      );
      log(`replica ${survivor} reads the agent ${offline} ${Date.now() - faultAt}ms after the crash (bound ${offlineMs}ms)`);
      expect(await first.ended, 'the socket to the crashed replica ended').toMatchObject({ by: 'server' });
    } finally {
      first.close();
    }

    const again = await switchClient.openAgentSocket(agent, connectionId, [room.id]);
    try {
      const reopenedAt = Date.now();
      await waitForStatus(switchClient, room.id, agent.id, isLive, 'live again', reopenedAt, 30_000);
      const { replica } = await connectionHolder(replicas!, connectionId);
      log(`reconnected through replica ${replica}; the agent reads live ${Date.now() - reopenedAt}ms later`);

      for (const id of [1, 2] as const) {
        if (!replicas!.running(id)) await replicas!.start(id);
        await replicas!.waitForRotation(id, 'UP', 30_000);
      }
      await waitForStatus(switchClient, room.id, agent.id, isLive, 'live on both replicas once both run', Date.now(), 30_000);
    } finally {
      again.close();
    }
  },
};

/** The replica holding controller `controllerId`'s connection, by its row, once it names `connectionId`. */
async function controllerHolder(
  replicas: Replicas,
  controllerId: string,
  connectionId: string,
  deadlineMs: number
): Promise<{ row: HeldConnection; replica: ReplicaId }> {
  const until = Date.now() + deadlineMs;
  let last: HeldConnection | undefined;
  while (Date.now() < until) {
    last = (await replicas.ownership('bridge')).controllers.find((row) => row.owner === controllerId);
    const replica = last === undefined ? null : replicaOf(last.processId);
    if (last !== undefined && last.id === connectionId && last.live && replica !== null) {
      return { row: last, replica };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `controller ${controllerId}'s row never named connection ${connectionId} on a live replica; last read ${JSON.stringify(last)}`
  );
}

async function waitForControllerState(
  switchClient: SwitchClient,
  controllerId: string,
  state: string,
  deadlineMs: number
): Promise<void> {
  const sinceMs = Date.now();
  let agreeing = 0;
  let last: string | undefined;
  while (Date.now() - sinceMs < deadlineMs) {
    last = (await switchClient.controllers()).find((controller) => controller.id === controllerId)?.state;
    agreeing = last === state ? agreeing + 1 : 0;
    if (agreeing >= AGREEING_READS) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`controller ${controllerId} did not read ${state} within ${deadlineMs}ms; it last read ${last}`);
}

/**
 * A controller's socket held by a replica that is paused, and the controller
 * opening its connection again through the other, as Switch Console does
 * when its socket stops answering. Opening is a takeover: once the paused
 * replica runs again, its socket must be evicted as `taken_over`, with
 * nothing after that, an attach with the old connection must be refused, and
 * the controller's row and state must stay with the new connection.
 *
 * @property controller.takeover-fenced
 * @property presence.online-iff-lease
 */
export const controllerSocketHolderPaused: FastScenario = {
  header: {
    id: 'replica-controller-socket-holder-paused',
    // The controller's own routes (`/v1/...`) are not on the surface the
    // coverage gate counts, which is operations and gateway routes.
    covers: ['POST /gateway/management/controllers', 'GET /gateway/management/controllers'],
    lane: 'fast',
    environments: ['ephemeral'],
    owner: 'platform',
    requires: ['replicas'],
  },
  async run({ switchClient, replicas, names, log, fixtures }) {
    const controller = await switchClient.enrollController(names.name('controller'));
    fixtures.defer(`controller ${controller.id}`, () => switchClient.revokeController(controller.id));
    const timers = (await replicas!.ownership('bridge')).timers;
    const sockets: HeldSocket[] = [];
    try {
      const first = await switchClient.openControllerConnection(controller);
      const old = await switchClient.openControllerSocket(controller, first);
      sockets.push(old);
      const { replica: holder } = await controllerHolder(replicas!, controller.id, first.connectionId, 10_000);
      const survivor = otherThan(holder);
      await waitForControllerState(switchClient, controller.id, 'online', 30_000);
      log(`controller ${controller.id}'s socket is held by replica ${holder}; it reads online`);

      replicas!.pause(holder);
      await replicas!.waitForRotation(holder, 'DOWN', 10_000);
      const taken = await switchClient.openControllerConnection(controller);
      const current = await switchClient.openControllerSocket(controller, taken);
      sockets.push(current);
      const { replica: now } = await controllerHolder(replicas!, controller.id, taken.connectionId, 10_000);
      expect(now, 'the connection opened again is held by the replica that runs').toBe(survivor);
      log(`opened again through replica ${survivor} (generation ${taken.generation})`);

      const resumedAt = Date.now();
      replicas!.resume(holder);
      const evictedMs = timers.recheckSeconds * 1000 + MARGIN_MS;
      const end = await Promise.race([
        old.ended,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), evictedMs)),
      ]);
      expect(end, `replica ${holder} kept the replaced socket open ${evictedMs}ms after it ran again`).not.toBeNull();
      const evicted = old.frames.findIndex((frame) => frame.event === 'evicted');
      expect(
        evicted,
        `the replaced socket ended without an evicted frame: ${JSON.stringify(old.frames.map((f) => f.event))}`
      ).toBeGreaterThanOrEqual(0);
      expect(old.frames[evicted]!.data).toMatchObject({ code: 'taken_over' });
      expect(
        old.frames.slice(evicted + 1).map((frame) => frame.event),
        'the replaced socket was sent frames after its eviction'
      ).toEqual([]);
      log(`replica ${holder} evicted the replaced socket ${Date.now() - resumedAt}ms after it ran again`);

      await replicas!.waitForRotation(holder, 'UP', 30_000);
      const stale = await switchClient.openControllerSocket(controller, first).then(
        (socket) => {
          sockets.push(socket);
          return null;
        },
        (error: unknown) => error
      );
      expect(stale, 'an attach with the replaced connection was accepted').toBeInstanceOf(SocketRefused);
      log(`an attach with the replaced connection is refused: ${JSON.stringify((stale as SocketRefused).detail)}`);

      const settled = await controllerHolder(replicas!, controller.id, taken.connectionId, 10_000);
      expect(settled.replica).toBe(survivor);
      await waitForControllerState(switchClient, controller.id, 'online', 30_000);
      expect(
        current.frames.filter((frame) => frame.event === 'evicted'),
        'the connection that took over was evicted'
      ).toEqual([]);
    } finally {
      for (const socket of sockets) socket.close();
    }
  },
};

export const REPLICA_CONNECTION_SCENARIOS: readonly FastScenario[] = [
  agentConnectionHolderKilled,
  controllerSocketHolderPaused,
];
