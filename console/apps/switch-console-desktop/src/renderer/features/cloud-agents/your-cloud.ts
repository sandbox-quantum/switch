import type { CloudMachine } from '@shared/core/cloud-agents/cloud-agents';

/** Room steps (designer): above 80% "A little left", from 95% "Full right now". */
export const NEARLY_FULL = 0.8;
export const FULL = 0.95;

export type RoomStep = 'plenty' | 'little' | 'full';

const ROOM_WORDS: Record<RoomStep, string> = {
  plenty: 'Plenty of room',
  little: 'A little left',
  full: 'Full right now',
};

const HEADING: Record<RoomStep, string> = {
  plenty: 'Ready',
  little: 'Nearly full',
  full: 'Full right now',
};

export type YourCloudView =
  | {
      /** No figures, just a heading and one line: the cloud is asleep, or
       * Switch paused it, or the person's admin turned it off. */
      resting: true;
      heading:
        | 'Resting'
        | 'Paused by Switch'
        | 'Turned off by your admin'
        | 'Stopped'
        | 'Starting…'
        | 'Stopping…';
      line: string;
      /** Offer Start, and how: `ensure` wakes a put-away (retained) box or a
       * resting one; `lifecycle` starts a box its owner stopped, which ensure
       * leaves as it is (Core's `ensure_machine`). Absent when Start isn't offered. */
      start?: 'ensure' | 'lifecycle';
      /** What the Start button says: "Wake" for a resting box with agents. */
      startLabel?: 'Start' | 'Wake';
    }
  | {
      resting: false;
      /** Ready, Nearly full or Full right now, from the room step (Ready when unknown). */
      heading: string;
      /** "Room to work": memory in use, as a share and a step. */
      room: { usedPercent: number; step: RoomStep; label: string } | null;
      /** "3 of 15 awake". */
      awake: { label: string } | null;
      /** "40 of 200 AI calls today, resets at 01:00", or the limit reached; null with no cap. */
      aiCalls: { label: string; capped: boolean } | null;
    };

function roomStep(share: number): RoomStep {
  if (share >= FULL) return 'full';
  if (share > NEARLY_FULL) return 'little';
  return 'plenty';
}

/** The box's states that mean it is on its way up. */
const STARTING_STATES: ReadonlySet<CloudMachine['state']> = new Set(['queued', 'provisioning']);

/**
 * Your cloud (visibility L1, U2 and U3), worded as the designer set it: the
 * room step, sessions awake and AI calls today. A resting, paused or turned-off
 * cloud shows no figures, and the AI-calls block is hidden when there's no cap. `time`
 * formats the reset in the viewer's local time.
 *
 * The figures and "Ready" come from the box's last report, so they show only
 * while the box is up. A box that is stopped, put away (retained), starting or
 * stopping shows its real state instead, with no figures, and Start where
 * nothing else would wake it: a retained or stopped box, or a resting one with
 * no agent to message. `state` and `desired_state` absent (an older caller)
 * read as up, as before.
 */
export function yourCloudView(
  machine: Pick<CloudMachine, 'room' | 'awake' | 'ai_calls_today' | 'sleeping'> & {
    stop_reason?: CloudMachine['stop_reason'];
    state?: CloudMachine['state'];
    desired_state?: CloudMachine['desired_state'];
    agents?: CloudMachine['agents'];
  },
  time: (at: Date) => string
): YourCloudView {
  // An operator's pause wins over the admin's switch, and both over resting
  // (the copy's priority). Their figures would be stale, so none show.
  if (machine.stop_reason === 'paused')
    return { resting: true, heading: 'Paused by Switch', line: 'Contact your admin' };
  if (machine.stop_reason === 'turned_off')
    return {
      resting: true,
      heading: 'Turned off by your admin',
      line: 'Ask your admin to turn it on',
    };
  const { state, desired_state: desired } = machine;
  const noAgents = machine.agents !== undefined && machine.agents.length === 0;
  if (state === 'retained' || desired === 'retained')
    return {
      resting: true,
      heading: 'Stopped',
      line: 'Start it to add or use an agent.',
      start: 'ensure',
    };
  if (state !== undefined && STARTING_STATES.has(state))
    return { resting: true, heading: 'Starting…', line: 'Usually ready in about two minutes.' };
  if (state === 'stopping')
    return { resting: true, heading: 'Stopping…', line: 'Start it again once it has stopped.' };
  if (machine.sleeping)
    return noAgents
      ? { resting: true, heading: 'Resting', line: 'Start it to add an agent.', start: 'ensure' }
      : {
          // Wake is offered too (PM review, story 2), as on the files view's
          // resting page; a message to an agent still wakes it by itself.
          resting: true,
          heading: 'Resting',
          line: 'Starts when you message an agent.',
          start: 'ensure',
          startLabel: 'Wake',
        };
  if (state === 'stopped' && desired === 'running')
    return { resting: true, heading: 'Starting…', line: 'Usually ready in about two minutes.' };
  if (state === 'stopped')
    return {
      resting: true,
      heading: 'Stopped',
      line: 'Start it to use your agents.',
      start: 'lifecycle',
    };
  if (state !== undefined && state !== 'ready')
    return { resting: true, heading: 'Stopped', line: 'Not running right now.' };
  const { room, awake, ai_calls_today: calls } = machine;
  const share = room ? room.used_bytes / room.total_bytes : null;
  const step = share === null ? null : roomStep(share);
  return {
    resting: false,
    heading: step === null ? 'Ready' : HEADING[step],
    room:
      room && share !== null && step !== null
        ? {
            usedPercent: Math.min(100, Math.round(share * 1000) / 10),
            step,
            label: ROOM_WORDS[step],
          }
        : null,
    awake: awake ? { label: `${awake.running} of ${awake.max} awake` } : null,
    aiCalls: calls
      ? {
          label: calls.capped
            ? `Today's AI limit is reached (${calls.cap}). It resets at ${time(new Date(calls.resets_at))}.`
            : `${calls.used} of ${calls.cap} AI calls today, resets at ${time(new Date(calls.resets_at))}`,
          capped: calls.capped,
        }
      : null,
  };
}

/**
 * Whether the agents on the box should read Stopped: Your cloud says Stopped
 * (put away, stopped by its owner, or not running), so a message won't start
 * it, and "Back when messaged" would be wrong (PM review).
 */
export function boxShowsStopped(machine: Parameters<typeof yourCloudView>[0]): boolean {
  return yourCloudView(machine, () => '').heading === 'Stopped';
}

/**
 * Whether signing in should wake the person's box (hosted agents v2): only when
 * they already have one and it has been put away (retained), which nothing
 * else wakes while it has no agent to message. Never to make a new box, and
 * never for a box Switch paused or their admin turned off, which Switch refuses.
 */
export function retainedBoxToWake(
  machines:
    | readonly Pick<CloudMachine, 'backend' | 'state' | 'desired_state' | 'stop_reason'>[]
    | null
): boolean {
  return (machines ?? []).some(
    (machine) =>
      machine.backend === 'box' &&
      (machine.state === 'retained' || machine.desired_state === 'retained') &&
      machine.stop_reason !== 'paused' &&
      machine.stop_reason !== 'turned_off'
  );
}
