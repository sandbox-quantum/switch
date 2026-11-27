import { expect } from 'vitest';
import type { MattermostClient } from '../clients/mattermost-client.ts';
import {
  otherThan,
  replicaOf,
  type Holder,
  type ReplicaId,
  type Replicas,
  type Timers,
} from '../clients/replicas.ts';
import { type AgentEvent, eventText, type RegisteredAgent, type SwitchClient } from '../clients/switch-client.ts';
import type { BridgedRoom } from '../fixtures/fixtures.ts';
import type { FastContext, FastScenario } from './scenario.ts';

/**
 * Process faults on a two-replica stack (`just e2e-fast --replicas 2`): the
 * replica holding the Mattermost bridge is crashed, stopped as a deploy stops
 * it, or paused past its lease, and the bridge must carry on from the other.
 *
 * Each checks, against the product's own timers (read from the server's
 * code by `properties/history/ownership.py`, never restated here):
 *
 * - `replica.single-owner`: the bridge has one holder, never two at once,
 *   read off `ownership_leases`, and every agent post reaches the channel
 *   exactly once, including one sent while no replica held the bridge;
 * - `replica.ownership-eventual`: the survivor holds the bridge, live, within
 *   the lease's lifetime and one balance of the fault;
 * - for the pause, `controller.takeover-fenced` at system level: the paused
 *   replica, once resumed, stops the work it no longer surely holds (and logs
 *   that it did) before posting anything, and the bridge ends up held once.
 *
 * A human post made before the new holder's sockets are open is lost: the
 * Mattermost adapter reads its sockets from the moment they connect and does
 * not fetch what was posted before. That gap is measured (the number of
 * probes lost is logged), not failed on, until the adapter catches up on
 * connect; what is checked is that no lost post turns up later, relayed by
 * the old holder.
 */

const BRIDGE = 'bridge';
/** Slack on every deadline derived from the timers: a poll, a request, a slow CI runner. */
const MARGIN_MS = 15_000;
/** How long a message must stay single before it counts as delivered once. */
const ONCE_WINDOW_MS = 10_000;

/**
 * Pause cycles the brief-pause scenario tries for one where the bridge hashes
 * to the replica started during the pause: each does with even odds, so all
 * missing is one run in 32.
 */
const PAUSE_CYCLES = 5;

const SUSPENDED = /^This process's lease .* was not renewed in time; stopping every piece of work it owns/;

interface Setup {
  agent: RegisteredAgent;
  bridged: BridgedRoom;
  holder: ReplicaId;
  timers: Timers;
}

async function setUp({ fixtures, replicas, log }: FastContext): Promise<Setup> {
  const agent = await fixtures.agent('fault');
  const bridged = await fixtures.mattermostRoom('room', [agent]);
  const ownership = await replicas!.settled(BRIDGE);
  const bridge = bridgeHolder(ownership.holders, bridged.room.bridgeId);
  const holder = replicaOf(bridge.processId);
  if (holder === null) {
    throw new Error(`the bridge is held by ${bridge.processId}, which names no replica`);
  }
  log(`bridge ${bridge.key} is held by replica ${holder} (${bridge.processId}, token ${bridge.token})`);
  return { agent, bridged, holder, timers: ownership.timers };
}

function bridgeHolder(holders: readonly Holder[], bridgeId: string | null): Holder {
  const row = holders.find((holder) => holder.key === bridgeId);
  if (row === undefined) {
    throw new Error(`no ownership row for bridge ${bridgeId}; rows: ${JSON.stringify(holders)}`);
  }
  return row;
}

/**
 * Wait until `replica` holds the bridge on a live lease, failing past
 * `deadlineMs` from `sinceMs`. Every read along the way must show at most one
 * holder of the row, which `ownership_leases` guarantees by its key; what is
 * checked is that the holder named is the one expected, and live.
 */
async function waitForHolder(
  replicas: Replicas,
  bridgeId: string | null,
  replica: ReplicaId,
  sinceMs: number,
  deadlineMs: number,
  log: (message: string) => void
): Promise<Holder> {
  let last: Holder | null = null;
  while (Date.now() - sinceMs < deadlineMs) {
    last = bridgeHolder((await replicas.ownership(BRIDGE)).holders, bridgeId);
    if (replicaOf(last.processId) === replica && last.live) {
      log(`replica ${replica} holds the bridge ${Date.now() - sinceMs}ms after the fault (token ${last.token})`);
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `replica ${replica} did not take the bridge over within ${deadlineMs}ms; last read: ${JSON.stringify(last)}`
  );
}

/** Every notification the agent is handed within `windowMs`. */
async function notificationsWithin(
  switchClient: SwitchClient,
  agent: RegisteredAgent,
  windowMs: number
): Promise<AgentEvent[]> {
  const until = Date.now() + windowMs;
  const events: AgentEvent[] = [];
  while (Date.now() < until) {
    const remaining = Math.max(1, Math.min(10, Math.ceil((until - Date.now()) / 1000)));
    events.push(...(await switchClient.pollNotifications(agent, remaining)));
  }
  return events;
}

/** The copies of an agent post in the channel since `sinceMs`. */
async function postCopies(
  mattermost: MattermostClient,
  bridged: BridgedRoom,
  agent: RegisteredAgent,
  text: string,
  sinceMs: number
): Promise<number> {
  const bot = bridged.bots.get(agent.id)!;
  const posts = await mattermost.postsFrom(bridged.channel.id, bot.id, sinceMs);
  return posts.filter((post) => post.message.includes(text)).length;
}

/**
 * Wait until the bridge is held, on a live lease, by the process it hashes
 * to among the live ones, failing past `deadlineMs` from `sinceMs`.
 */
async function waitForRightfulHolder(
  replicas: Replicas,
  bridgeId: string | null,
  sinceMs: number,
  deadlineMs: number,
  log: (message: string) => void
): Promise<Holder> {
  let last: Holder | null = null;
  while (Date.now() - sinceMs < deadlineMs) {
    last = bridgeHolder((await replicas.ownership(BRIDGE)).holders, bridgeId);
    if (last.live && last.processId !== null && last.processId === last.owner) {
      log(`${last.processId} holds the bridge it hashes to ${Date.now() - sinceMs}ms after the resume`);
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `the bridge did not settle on the process it hashes to within ${deadlineMs}ms; last read: ${JSON.stringify(last)}`
  );
}

/** An agent post appears in the channel exactly once, within `deadlineMs`. */
async function expectPostedOnce(
  mattermost: MattermostClient,
  bridged: BridgedRoom,
  agent: RegisteredAgent,
  text: string,
  sinceMs: number,
  deadlineMs: number
): Promise<void> {
  const bot = bridged.bots.get(agent.id)!;
  const seen = await mattermost.waitForPost({
    channelId: bridged.channel.id,
    fromUserId: bot.id,
    predicate: (post) => post.message.includes(text),
    sinceMs,
    deadlineMs,
  });
  expect(
    seen.match,
    `'${text}' never appeared as bot ${bot.username}; channel said: ` +
      seen.transcript.map((post) => `${post.user_id}: ${post.message}`).join(' | ')
  ).not.toBeNull();
  await new Promise((resolve) => setTimeout(resolve, ONCE_WINDOW_MS));
  const copies = await postCopies(mattermost, bridged, agent, text, sinceMs);
  expect(copies, `'${text}' was posted ${copies} times`).toBe(1);
}

/** A human's `@agent` post reaches the agent exactly once, within `deadlineMs`. */
async function expectDeliveredOnce(
  switchClient: SwitchClient,
  mattermost: MattermostClient,
  bridged: BridgedRoom,
  agent: RegisteredAgent,
  marker: string,
  deadlineMs: number
): Promise<void> {
  await mattermost.post({ channelId: bridged.channel.id, message: `@${agent.name} ${marker}` });
  const first = await switchClient.waitForNotification(
    agent,
    (event) => eventText(event).includes(marker),
    deadlineMs
  );
  if (first.match === null) {
    // Which half failed: the bridge never wrote the post into the room, or
    // the room has it and the agent was never handed it.
    const history = await switchClient.roomHistory(agent, bridged.room.id, 50);
    const inRoom = history.some((event) => event.body.includes(marker));
    throw new Error(
      `'${marker}' never reached the agent; the room ${inRoom ? 'has it' : 'does not have it either'}; ` +
        `the agent saw ${JSON.stringify(first.seen).slice(0, 800)}`
    );
  }
  const after = await notificationsWithin(switchClient, agent, ONCE_WINDOW_MS);
  const copies = [...first.seen, ...after].filter((event) => eventText(event).includes(marker)).length;
  expect(copies, `'${marker}' reached the agent ${copies} times`).toBe(1);
}

/**
 * Right after a hand-over, a human's post reaches the agent once the new
 * holder's sockets are open. Until then a post is lost: the Mattermost adapter
 * does not fetch what was posted before its socket opened. Posts one probe
 * after another until one arrives, says how many were lost, and checks that
 * the one that arrived arrived once and that no lost one turns up late (as
 * one the old holder's socket buffered would, were it relayed).
 */
async function expectDeliveredAfterHandOver(
  { switchClient, mattermost, names, log }: FastContext,
  { agent, bridged }: Setup,
  label: string,
  deadlineMs: number
): Promise<string[]> {
  const until = Date.now() + deadlineMs;
  const probes: string[] = [];
  const handed: AgentEvent[] = [];
  let arrived: string | null = null;
  while (arrived === null && Date.now() < until) {
    const probe = names.marker(`${label}${probes.length}`);
    probes.push(probe);
    await mattermost!.post({ channelId: bridged.channel.id, message: `@${agent.name} ${probe}` });
    const seen = await switchClient.waitForNotification(
      agent,
      (event) => probes.some((p) => eventText(event).includes(p)),
      5_000
    );
    handed.push(...seen.seen);
    if (seen.match !== null) arrived = probes.find((p) => eventText(seen.match!).includes(p))!;
  }
  if (arrived === null) {
    throw new Error(`none of ${probes.length} posts reached the agent within ${deadlineMs}ms of the hand-over`);
  }
  const lost = probes.slice(0, probes.indexOf(arrived));
  log(`${label}: ${lost.length} post(s) lost before the new holder's sockets were open`);
  handed.push(...(await notificationsWithin(switchClient, agent, ONCE_WINDOW_MS)));
  const probesHanded = handed.map(eventText).filter((text) => probes.some((p) => text.includes(p)));
  expect(
    probesHanded,
    `after '${arrived}' arrived, the agent was handed these probes: ${probesHanded.join(' | ')}`
  ).toHaveLength(1);
  return lost;
}

/**
 * Both directions work, each exactly once. `inbound` says whether the bridge
 * has been held where it is for a while (`settled`) or was just handed over,
 * when a human's post may be lost (`expectDeliveredAfterHandOver`). Returns
 * the posts lost.
 */
async function roundTrip(
  context: FastContext,
  setup: Setup,
  label: string,
  inbound: 'settled' | 'just-handed-over',
  deadlineMs: number
): Promise<string[]> {
  const { switchClient, mattermost, names, log } = context;
  const { agent, bridged } = setup;
  const marker = names.marker(label);
  let lost: string[] = [];
  if (inbound === 'settled') {
    await expectDeliveredOnce(switchClient, mattermost!, bridged, agent, `in ${marker}`, deadlineMs);
  } else {
    lost = await expectDeliveredAfterHandOver(context, setup, label, deadlineMs);
  }
  const sinceMs = Date.now();
  await switchClient.sendMessage(agent, bridged.room.id, `out ${marker}`);
  await expectPostedOnce(mattermost!, bridged, agent, `out ${marker}`, sinceMs, deadlineMs);
  log(`${label}: both directions, once each`);
  return lost;
}

/**
 * Stop the holder with `signal`, then: a post the agent sends while nothing
 * may hold the bridge reaches the channel once, the survivor holds the bridge
 * within `deadline(timers)`, and both directions work through it. Then the
 * stopped replica is started again and the round trip checked once more,
 * wherever the bridge settles.
 */
async function stopHolder(
  context: FastContext,
  signal: 'SIGKILL' | 'SIGTERM',
  deadline: (timers: Timers) => number
): Promise<void> {
  const { replicas, switchClient, names, log } = context;
  const setup = await setUp(context);
  const { agent, bridged, holder, timers } = setup;
  const survivor = otherThan(holder);
  await roundTrip(context, setup, 'before', 'settled', 60_000);

  const faultAt = Date.now();
  await replicas!.stop(holder, signal);
  await replicas!.waitForRotation(holder, 'DOWN', 10_000);

  const gap = `gap ${names.marker('gap')}`;
  const gapSince = Date.now();
  await switchClient.sendMessage(agent, bridged.room.id, gap);
  const takeOver = deadline(timers);
  await waitForHolder(replicas!, bridged.room.bridgeId, survivor, faultAt, takeOver, log);
  await expectPostedOnce(context.mattermost!, bridged, agent, gap, gapSince, takeOver);
  await roundTrip(context, setup, 'after', 'just-handed-over', 60_000);

  await replicas!.start(holder);
  await replicas!.waitForRotation(holder, 'UP', 30_000);
  await replicas!.settled(BRIDGE);
  await roundTrip(context, setup, 'restarted', 'settled', 60_000);
}

const header = (id: string): FastScenario['header'] => ({
  id,
  covers: ['POST /agents/{agent_id}/message', 'GET /agents/{agent_id}/notifications'],
  lane: 'fast',
  environments: ['ephemeral'],
  owner: 'platform',
  requires: ['mattermost', 'replicas'],
});

/**
 * A crash: the holder writes nothing on its way out, so its claim on the
 * bridge holds until its lease lapses, and the survivor takes the bridge at
 * its first balance after that.
 *
 * @property replica.single-owner
 * @property replica.ownership-eventual
 */
export const bridgeHolderKilled: FastScenario = {
  header: header('replica-bridge-holder-killed'),
  async run(context) {
    await stopHolder(context, 'SIGKILL', (t) => (t.leaseTtl + t.balanceInterval) * 1000 + MARGIN_MS);
  },
};

/**
 * A deploy: the holder lets go of the bridge and marks its lease stopped as
 * it shuts down, so the survivor takes it at its next balance, without
 * waiting out the lease.
 *
 * @property replica.single-owner
 * @property replica.ownership-eventual
 */
export const bridgeHolderStopped: FastScenario = {
  header: header('replica-bridge-holder-stopped'),
  async run(context) {
    await stopHolder(context, 'SIGTERM', (t) => t.balanceInterval * 1000 + MARGIN_MS);
  },
};

/**
 * A pause longer than the lease (a stalled VM, a long GC): the paused holder
 * cannot know its lease lapsed. The survivor takes the bridge; once resumed,
 * the old holder must stop its copy of the bridge, logging that it did,
 * before it relays anything, and the bridge must end up held, and every
 * message delivered, once.
 *
 * @property replica.single-owner
 * @property replica.ownership-eventual
 */
export const bridgeHolderPaused: FastScenario = {
  header: header('replica-bridge-holder-paused'),
  expectedServerErrors: [SUSPENDED],
  async run(context) {
    const { replicas, switchClient, names, log } = context;
    const setup = await setUp(context);
    const { agent, bridged, holder, timers } = setup;
    const survivor = otherThan(holder);
    await roundTrip(context, setup, 'before', 'settled', 60_000);

    const mark = replicas!.logMark(holder);
    const faultAt = Date.now();
    replicas!.pause(holder);
    await replicas!.waitForRotation(holder, 'DOWN', 10_000);
    // Posted while only the paused holder's sockets are open: it reaches
    // nobody now, and waits in their buffers for the holder to run again.
    const buffered = names.marker('buffered');
    await context.mattermost!.post({
      channelId: bridged.channel.id,
      message: `@${agent.name} ${buffered}`,
    });
    await waitForHolder(
      replicas!,
      bridged.room.bridgeId,
      survivor,
      faultAt,
      (timers.leaseTtl + timers.balanceInterval) * 1000 + MARGIN_MS,
      log
    );
    const lost = [buffered, ...(await roundTrip(context, setup, 'paused', 'just-handed-over', 60_000))];

    // Sent before the old holder runs again, so its copy of the bridge, if
    // it were still relaying, would have it to post a second time.
    const crossing = `crossing ${names.marker('crossing')}`;
    const crossingSince = Date.now();
    await switchClient.sendMessage(agent, bridged.room.id, crossing);
    replicas!.resume(holder);
    await expectPostedOnce(context.mattermost!, bridged, agent, crossing, crossingSince, 60_000);

    const suspendBy = Date.now() + timers.balanceInterval * 1000 + MARGIN_MS;
    while (!replicas!.logSince(holder, mark).some((record) => SUSPENDED.test(record.message))) {
      if (Date.now() > suspendBy) {
        throw new Error(
          `replica ${holder} ran again after a pause past its lease and never logged that it stopped its work`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    log(`replica ${holder} stopped its work once it ran again`);
    // Counted again now its copy of the bridge has stopped: a relay of its
    // own before then may have come after the first count.
    const crossingCopies = await postCopies(context.mattermost!, bridged, agent, crossing, crossingSince);
    expect(crossingCopies, `'${crossing}' was posted ${crossingCopies} times`).toBe(1);

    // A post lost while the holder was paused may sit in its socket's
    // buffer; relayed now, it would reach the agent long after the bridge
    // had moved on.
    const late = await switchClient.waitForNotification(
      agent,
      (event) => lost.some((probe) => eventText(event).includes(probe)),
      ONCE_WINDOW_MS
    );
    expect(
      late.match,
      `a post lost while replica ${holder} was paused was relayed once it ran again: ` +
        (late.match === null ? '' : eventText(late.match))
    ).toBeNull();

    await replicas!.waitForRotation(holder, 'UP', 30_000);
    await replicas!.settled(BRIDGE);
    await roundTrip(context, setup, 'resumed', 'settled', 60_000);
  },
};

/**
 * A pause shorter than the lease, with a replica added meanwhile: the case the
 * eventual-ownership model found. The other replica is stopped, so the holder
 * runs everything; the holder is paused for longer than half its lease but
 * not long enough for its lease to lapse, and the other replica starts during
 * the pause. The newcomer must claim nothing while the paused holder's lease
 * holds, though the bridge may now hash to it. Once the holder runs again,
 * the bridge must settle on whichever of the two it hashes to, within two
 * balances, held once throughout, and a message the agent sent during the
 * pause must be posted once. Repeated until a cycle where the bridge hashes
 * to the newcomer (`PAUSE_CYCLES`).
 *
 * Past half its lease the paused holder can no longer be sure of it, so once
 * resumed it stops its work and claims its share back (`Ownership`'s lapse
 * latch), and logs that it stopped.
 *
 * @property replica.single-owner
 * @property replica.ownership-eventual
 */
export const bridgeHolderPausedBriefly: FastScenario = {
  header: header('replica-bridge-holder-paused-briefly'),
  expectedServerErrors: [SUSPENDED],
  async run(context) {
    const { replicas, switchClient, names, log } = context;
    const setup = await setUp(context);
    const { agent, bridged, holder, timers } = setup;
    const newcomer = otherThan(holder);
    await roundTrip(context, setup, 'before', 'settled', 60_000);

    // Past half the lease, so the holder is sure to have stopped trusting it,
    // and short of the lease less a renewal interval, since its last renewal
    // may have been sent up to one interval before the pause: half way.
    const pauseMs = ((timers.leaseTtl / 2 + (timers.leaseTtl - timers.renewEvery)) / 2) * 1000;
    const settleMs = 2 * timers.balanceInterval * 1000 + MARGIN_MS;

    // The newcomer's process id, and so where the bridge hashes, is drawn as
    // it starts. A cycle where the bridge hashes to the holder checks all but
    // the newcomer keeping off a key it wants, so cycles repeat, each with a
    // newcomer of a new id, until one hashes to the newcomer.
    for (let cycle = 1; cycle <= PAUSE_CYCLES; cycle += 1) {
      await replicas!.stop(newcomer, 'SIGTERM');
      await replicas!.waitForRotation(newcomer, 'DOWN', 10_000);

      const mark = replicas!.logMark(holder);
      const pausedAt = Date.now();
      replicas!.pause(holder);
      await Promise.all([replicas!.waitForRotation(holder, 'DOWN', pauseMs), replicas!.start(newcomer)]);
      await replicas!.waitForRotation(newcomer, 'UP', pauseMs);

      // Sent while the only replica that held the bridge is paused: it waits
      // in the room until a copy of the bridge relays it.
      const crossing = `crossing ${names.marker(`crossing${cycle}`)}`;
      const crossingSince = Date.now();
      await switchClient.sendMessage(agent, bridged.room.id, crossing);

      const row = bridgeHolder((await replicas!.ownership(BRIDGE)).holders, bridged.room.bridgeId);
      const elapsed = Date.now() - pausedAt;
      if (elapsed >= pauseMs) {
        replicas!.resume(holder);
        throw new Error(
          `replica ${newcomer} took ${elapsed}ms to start and be read, past the ${pauseMs}ms pause; ` +
            'the case needs it to start while the holder is paused'
        );
      }
      const wanted = replicaOf(row.owner) === newcomer;
      log(
        `cycle ${cycle}: replica ${newcomer} started ${elapsed}ms into a ${pauseMs}ms pause; ` +
          `the bridge hashes to ${wanted ? 'it' : `replica ${holder}`} (${row.owner})`
      );
      expect(
        replicaOf(row.processId),
        `replica ${newcomer} took the bridge while replica ${holder}'s lease still held: ${JSON.stringify(row)}`
      ).toBe(holder);

      await new Promise((resolve) => setTimeout(resolve, pauseMs - elapsed));
      const resumedAt = Date.now();
      replicas!.resume(holder);

      const settled = await waitForRightfulHolder(replicas!, bridged.room.bridgeId, resumedAt, settleMs, log);
      expect(replicaOf(settled.processId), 'the bridge settled where it hashes').toBe(wanted ? newcomer : holder);
      expect(
        replicas!.logSince(holder, mark).some((record) => SUSPENDED.test(record.message)),
        `replica ${holder} ran again after a pause past half its lease and never logged that it stopped its work`
      ).toBe(true);
      await expectPostedOnce(context.mattermost!, bridged, agent, crossing, crossingSince, settleMs);
      if (wanted) {
        log(`the bridge moved to replica ${newcomer}`);
        await roundTrip(context, setup, 'after', 'just-handed-over', 60_000);
        return;
      }
      await roundTrip(context, setup, `stayed${cycle}`, 'settled', 60_000);
    }
    throw new Error(
      `in ${PAUSE_CYCLES} cycles the bridge never hashed to the replica started during the pause, ` +
        'so the case of a newcomer keeping off a key it wants was not reached'
    );
  },
};

/**
 * The holder taken out of HAProxy's rotation, its sessions severed: it keeps
 * running and keeps the bridge, whose Mattermost sockets do not go through
 * HAProxy, while every request lands on the other replica. Both directions
 * work once each meanwhile, and again once it is back in rotation.
 *
 * @property replica.single-owner
 */
export const bridgeHolderDrained: FastScenario = {
  header: header('replica-bridge-holder-drained'),
  async run(context) {
    const { replicas, log } = context;
    const setup = await setUp(context);
    const { bridged, holder } = setup;
    await roundTrip(context, setup, 'before', 'settled', 60_000);
    const before = bridgeHolder((await replicas!.ownership(BRIDGE)).holders, bridged.room.bridgeId);

    await replicas!.drain(holder);
    expect(await replicas!.rotation(holder)).toBe('MAINT');
    await roundTrip(context, setup, 'drained', 'settled', 60_000);
    const during = bridgeHolder((await replicas!.ownership(BRIDGE)).holders, bridged.room.bridgeId);
    expect(
      [during.processId, during.token, during.live],
      `the bridge changed hands while replica ${holder} was only out of rotation`
    ).toEqual([before.processId, before.token, true]);
    log(`replica ${holder} kept the bridge out of rotation (token ${during.token})`);

    await replicas!.undrain(holder);
    await replicas!.waitForRotation(holder, 'UP', 30_000);
    await roundTrip(context, setup, 'undrained', 'settled', 60_000);
  },
};

export const REPLICA_FAULT_SCENARIOS: readonly FastScenario[] = [
  bridgeHolderKilled,
  bridgeHolderStopped,
  bridgeHolderPaused,
  bridgeHolderPausedBriefly,
  bridgeHolderDrained,
];
