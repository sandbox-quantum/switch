import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { type Deafened, type ListenerRole, otherThan, type ReplicaId, type Timers } from '../clients/replicas.ts';
import type { SwitchClient } from '../clients/switch-client.ts';
import { ONCE_WINDOW_MS, postCopies, roundTrip, setUp } from './replica-faults.ts';
import type { FastContext, FastScenario } from './scenario.ts';

/**
 * Bus faults on a two-replica stack (`just e2e-fast --replicas 2`): one
 * replica's listening connection is cut, just after its heartbeat, and cut
 * again each time it reconnects for a window (`Replicas.deafen`), while the
 * replica goes on serving requests on its pool. Whatever is sent on that
 * channel meanwhile never reaches it. The other replica makes a change, and
 * the deaf one must act on it within a bound derived from the product's own
 * timers (`properties/history/ownership.py`):
 *
 * - `revocation.takes-effect-everywhere`: what the deaf replica holds of a
 *   revoked membership or controller lasts no longer than a held row's TTL
 *   once the signal connection it was read under is gone;
 * - `signal.loss-only-delays`: a change whose signal or wake-up was lost is
 *   acted on once the listener reconnects, which it does within its first
 *   backoff, and not left for the periodic re-check.
 *
 * Each scenario also checks that the listener is back within its first
 * backoff once the cuts stop, however many times it was cut.
 */

/**
 * Slack on a bound derived from the timers: a poll, a request. Kept well
 * under a listener's heartbeat, which is how long a listener that does not
 * notice its connection end stays deaf.
 */
const SLACK_MS = 3_000;
/** The same, for a bound that includes a post reaching Mattermost. */
const MATTERMOST_SLACK_MS = 6_000;
/**
 * How much longer the disconnect scenario keeps cutting: the replica holding
 * a connection reads it offline some time after its socket closes (about 22
 * seconds on the lane), and the deaf replica must still be deaf then.
 */
const HOLDER_OFFLINE_MS = 30_000;
/** Between two attempts while waiting for a change to take effect. */
const POLL_MS = 250;

/** What a replica logs each time a cut ends its listener; expected here, as the fault. */
const LISTENER_LOST = [
  /^Signal listener lost its connection; retrying in /,
  /^Message listener lost its connection; retrying in /,
];

const header = (
  id: string,
  covers: string[],
  requires: FastScenario['header']['requires']
): FastScenario['header'] => ({
  id,
  covers,
  lane: 'fast',
  environments: ['ephemeral'],
  owner: 'platform',
  requires,
});

/**
 * How long to keep the listener cut: past the heartbeat, so a replica that
 * learns of a cut only from its heartbeat is still deaf when the bound is
 * checked, and past the bound itself.
 */
function windowMs(timers: Timers): number {
  return (timers.listenerHeartbeat + timers.cacheTtl) * 1000 + 2 * SLACK_MS;
}

/** Poll `attempt` until it says done, failing past `boundMs` from `sinceMs`. Returns how long it took. */
async function within(
  what: string,
  sinceMs: number,
  boundMs: number,
  attempt: () => Promise<boolean>
): Promise<number> {
  while (Date.now() - sinceMs <= boundMs) {
    if (await attempt()) return Date.now() - sinceMs;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`${what} did not happen within ${boundMs}ms`);
}

/** The listener is back within its first backoff once the cuts stopped. */
async function expectBack(
  deafened: Deafened,
  replica: ReplicaId,
  role: ListenerRole,
  timers: Timers,
  log: (message: string) => void
): Promise<void> {
  const { cuts, backAt } = await deafened.done;
  const lastCut = cuts.at(-1)!.at;
  const boundMs = timers.reconnectBackoff * 1000 + SLACK_MS;
  expect(
    backAt,
    `replica ${replica}'s ${role} listener was not back within 30s of the last of ${cuts.length} cuts`
  ).not.toBeNull();
  log(
    `replica ${replica}'s ${role} listener was cut ${cuts.length} times, and back ${backAt! - lastCut}ms after the last`
  );
  expect(
    backAt! - lastCut,
    `replica ${replica}'s ${role} listener took longer than its first backoff and ${SLACK_MS}ms to come back after ${cuts.length} cuts`
  ).toBeLessThanOrEqual(boundMs);
}

/**
 * Run `checks` while the replica is deaf, and wait for the cutting to end
 * whether or not they pass, so a failed check does not leave the next
 * scenario a replica without its listener. Then check that the listener came
 * back within its first backoff.
 */
async function whileDeaf(
  deafened: Deafened,
  replica: ReplicaId,
  role: ListenerRole,
  timers: Timers,
  log: (message: string) => void,
  checks: () => Promise<void>
): Promise<void> {
  try {
    await deafened.cutAt;
    await checks();
  } catch (error) {
    await deafened.done.catch(() => undefined);
    throw error;
  }
  await expectBack(deafened, replica, role, timers, log);
}

/** Statuses at or above 400 and below 500 are refusals; anything else from a refused request is an error. */
function refused(status: number): boolean {
  if (status >= 500) throw new Error(`the request failed with ${status} rather than being refused`);
  return status >= 400;
}

/**
 * An agent taken out of a room by one replica while the other's signal
 * listener is cut. The deaf replica had read the membership while it
 * listened, so it holds it; once the connection it was read under is gone,
 * the hold lasts the TTL and no longer, and the agent's posts through the
 * deaf replica must be refused within it.
 *
 * @property revocation.takes-effect-everywhere
 */
export const membershipRevokedWhileDeaf: FastScenario = {
  header: header(
    'replica-membership-revoked-while-deaf',
    ['POST /agents/{agent_id}/message', 'DELETE /gateway/rooms/{room_id}/agents/{agent_id}'],
    ['replicas']
  ),
  expectedServerErrors: LISTENER_LOST,
  async run({ fixtures, switchClient, replicas, names, log }) {
    const agent = await fixtures.agent('revoked');
    const room = await fixtures.internalRoom('room', [agent]);
    const deaf: ReplicaId = 1;
    const viaDeaf = switchClient.at(deaf);
    const timers = (await replicas!.ownership('bridge')).timers;
    const post = (label: string) =>
      viaDeaf.agentAttempt(agent, 'POST', `/agents/${agent.id}/message`, {
        room_id: room.id,
        content: `${label} ${names.marker(label)}`,
      });
    expect((await post('held')).status, 'the agent could not post through the replica made deaf').toBe(200);

    const deafened = replicas!.deafen(deaf, 'signals', windowMs(timers));
    await whileDeaf(deafened, deaf, 'signals', timers, log, async () => {
      // Read again now, so what the deaf replica holds is fresh, and the
      // refusal below waits out the TTL rather than finding it already over.
      expect((await post('fresh')).status, 'the agent could not post through the deaf replica').toBe(200);
      await switchClient.at(otherThan(deaf)).removeAgentFromRoom(room.id, agent.id);
      const removedAt = Date.now();
      log(`replica ${otherThan(deaf)} took the agent out of the room; replica ${deaf} is deaf`);

      let accepted = 0;
      const boundMs = timers.cacheTtl * 1000 + SLACK_MS;
      const tookMs = await within(
        `replica ${deaf} refusing the removed agent's posts`,
        removedAt,
        boundMs,
        async () => {
          const status = (await post('after')).status;
          if (refused(status)) return true;
          accepted += 1;
          return false;
        }
      );
      log(
        `replica ${deaf} refused the removed agent's post ${tookMs}ms after the removal, having accepted ${accepted}`
      );
      for (let again = 0; again < 3; again++) {
        expect(refused((await post('again')).status), `replica ${deaf} accepted a post after refusing one`).toBe(true);
      }
    });
  },
};

/**
 * A controller revoked by one replica while the other's signal listener is
 * cut. The deaf replica had authenticated the controller while it listened,
 * so it holds the controller's row; the hold lasts the TTL once the
 * connection it was read under is gone, and the controller's token must be
 * refused through the deaf replica within it.
 *
 * @property revocation.takes-effect-everywhere
 */
export const controllerRevokedWhileDeaf: FastScenario = {
  header: header(
    'replica-controller-revoked-while-deaf',
    // The controller's own routes (`/v1/...`) are not on the surface the
    // coverage gate counts, which is operations and gateway routes.
    ['DELETE /gateway/management/controllers/{controller_id}'],
    ['replicas']
  ),
  expectedServerErrors: LISTENER_LOST,
  async run({ fixtures, switchClient, replicas, names, log }) {
    const controller = await switchClient.enrollController(names.name('controller'));
    let revoked = false;
    fixtures.defer(`controller ${controller.id}`, async () => {
      if (!revoked) await switchClient.revokeController(controller.id);
    });
    const deaf: ReplicaId = 1;
    const viaDeaf = switchClient.at(deaf);
    const timers = (await replicas!.ownership('bridge')).timers;
    expect(
      await viaDeaf.controllerAssignmentStatus(controller),
      'the controller was refused before its revocation'
    ).toBe(200);

    const deafened = replicas!.deafen(deaf, 'signals', windowMs(timers));
    await whileDeaf(deafened, deaf, 'signals', timers, log, async () => {
      // Read again now, as for the membership: the refusal must wait out the TTL.
      expect(await viaDeaf.controllerAssignmentStatus(controller), 'the controller was refused while deaf').toBe(200);
      await switchClient.at(otherThan(deaf)).revokeController(controller.id);
      revoked = true;
      const revokedAt = Date.now();
      log(`replica ${otherThan(deaf)} revoked the controller; replica ${deaf} is deaf`);

      let accepted = 0;
      const boundMs = timers.cacheTtl * 1000 + SLACK_MS;
      const tookMs = await within(`replica ${deaf} refusing the revoked controller`, revokedAt, boundMs, async () => {
        if (refused(await viaDeaf.controllerAssignmentStatus(controller))) return true;
        accepted += 1;
        return false;
      });
      log(`replica ${deaf} refused the revoked controller ${tookMs}ms after the revocation, having served ${accepted}`);
    });
  },
};

/** Whether `agentId` reads live in the room on `switchClient`'s replica. */
async function readsLive(switchClient: SwitchClient, roomId: string, agentId: string): Promise<boolean> {
  return (await switchClient.agentStatusInRoom(roomId, agentId)) === 'live';
}

/**
 * An agent's connection held by one replica and closed while the other's
 * signal listener is cut. The deaf replica keeps a copy of the connection's
 * row, so it read the agent live; the signal that the connection closed
 * never reaches it, and it must read the agent offline once its listener
 * reconnects and re-reads the rows, within the first backoff of the replica
 * that closed it reading it offline, rather than at the periodic re-check.
 *
 * @property signal.loss-only-delays
 * @property presence.online-iff-lease
 */
export const disconnectWhileDeaf: FastScenario = {
  header: header(
    'replica-disconnect-while-deaf',
    ['GET /agents/{agent_id}/connection/ws', 'GET /gateway/rooms/{room_id}'],
    ['replicas']
  ),
  expectedServerErrors: LISTENER_LOST,
  async run({ fixtures, switchClient, replicas, log }) {
    const agent = await fixtures.agent('presence');
    const room = await fixtures.internalRoom('room', [agent]);
    const deaf: ReplicaId = 1;
    const holder = otherThan(deaf);
    const viaDeaf = switchClient.at(deaf);
    const viaHolder = switchClient.at(holder);
    const timers = (await replicas!.ownership('bridge')).timers;

    const socket = await viaHolder.openAgentSocket(agent, randomUUID(), [room.id]);
    try {
      await within('the agent reading live on both replicas', Date.now(), 30_000, async () => {
        return (await readsLive(viaDeaf, room.id, agent.id)) && (await readsLive(viaHolder, room.id, agent.id));
      });
    } catch (error) {
      socket.close();
      throw error;
    }
    const deafened = replicas!.deafen(deaf, 'signals', windowMs(timers) + HOLDER_OFFLINE_MS);
    await whileDeaf(deafened, deaf, 'signals', timers, log, async () => {
      socket.close();
      const closedAt = Date.now();
      log(`the agent's socket to replica ${holder} closed; replica ${deaf} is deaf`);

      const heardMs = await within(`replica ${holder} reading the agent offline`, closedAt, 30_000, async () => {
        return !(await readsLive(viaHolder, room.id, agent.id));
      });
      const boundMs = heardMs + timers.reconnectBackoff * 1000 + SLACK_MS;
      const tookMs = await within(`replica ${deaf} reading the agent offline`, closedAt, boundMs, async () => {
        return !(await readsLive(viaDeaf, room.id, agent.id));
      });
      log(
        `replica ${holder} read the agent offline ${heardMs}ms after the close, replica ${deaf} ${tookMs}ms after it`
      );
    });
  },
};

/**
 * The bridge's holder with its message listener cut. An agent posts through
 * the other replica, a post at a time, spaced across more than a room
 * re-check; the wake-up that tells the holder's bridge the room has a new row
 * never reaches it, and each post must reach the Mattermost channel once the
 * listener reconnects, which wakes every room, within its first backoff, and
 * exactly once.
 *
 * @property signal.loss-only-delays
 * @property bridge.roundtrip-exactly-once
 */
export const wakeupsLostWhileDeaf: FastScenario = {
  header: header(
    'replica-wakeups-lost-while-deaf',
    ['POST /agents/{agent_id}/message', 'GET /agents/{agent_id}/notifications'],
    ['mattermost', 'replicas']
  ),
  expectedServerErrors: LISTENER_LOST,
  async run(context: FastContext) {
    const { replicas, switchClient, mattermost, names, log } = context;
    const setup = await setUp(context);
    const { agent, bridged, holder, timers } = setup;
    await roundTrip(context, setup, 'before', 'settled', 60_000);

    const boundMs = timers.reconnectBackoff * 1000 + MATTERMOST_SLACK_MS;
    // Posts spaced past the bound, across more than a room re-check: the
    // re-check would relay at most two in time, so a holder that relies on it
    // rather than on waking every room when its listener reconnects fails.
    const spacingMs = boundMs + 1_000;
    const count = Math.ceil((timers.roomRecheck * 1000 + boundMs) / spacingMs);
    const viaOther = switchClient.at(otherThan(holder));
    const bot = bridged.bots.get(agent.id)!;
    const deafened = replicas!.deafen(holder, 'messages', windowMs(timers) + count * spacingMs);
    await whileDeaf(deafened, holder, 'messages', timers, log, async () => {
      const firstSentAt = Date.now();
      const texts: string[] = [];
      const late: string[] = [];
      for (let i = 0; i < count; i++) {
        const text = `deaf${i} ${names.marker(`deaf${i}`)}`;
        texts.push(text);
        const sentAt = Date.now();
        await viaOther.sendMessage(agent, bridged.room.id, text);
        const seen = await mattermost!.waitForPost({
          channelId: bridged.channel.id,
          fromUserId: bot.id,
          predicate: (post) => post.message.includes(text),
          sinceMs: sentAt,
          deadlineMs: boundMs,
        });
        const tookMs = Date.now() - sentAt;
        if (seen.match === null) late.push(text);
        else log(`'${text}' reached the channel ${tookMs}ms after it was sent through replica ${otherThan(holder)}`);
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, spacingMs - tookMs)));
      }
      expect(
        late,
        `posts made while replica ${holder}, the bridge's holder, was deaf did not reach the channel within ${boundMs}ms`
      ).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, ONCE_WINDOW_MS));
      for (const text of texts) {
        const copies = await postCopies(mattermost!, bridged, agent, text, firstSentAt);
        expect(copies, `'${text}' was posted ${copies} times`).toBe(1);
      }
    });
    await roundTrip(context, setup, 'after', 'settled', 60_000);
  },
};

export const REPLICA_BUS_FAULT_SCENARIOS: readonly FastScenario[] = [
  membershipRevokedWhileDeaf,
  controllerRevokedWhileDeaf,
  disconnectWhileDeaf,
  wakeupsLostWhileDeaf,
];
