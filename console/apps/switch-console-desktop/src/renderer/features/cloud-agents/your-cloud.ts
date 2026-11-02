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
      heading: 'Resting' | 'Paused by Switch' | 'Turned off by your admin';
      line: string;
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

/**
 * Your cloud (visibility L1, U2 and U3), worded as the designer set it: the
 * room step, sessions awake and AI calls today. A resting, paused or turned-off
 * cloud shows no figures, and the AI-calls block is hidden when there's no cap. `time`
 * formats the reset in the viewer's local time.
 */
export function yourCloudView(
  machine: Pick<CloudMachine, 'room' | 'awake' | 'ai_calls_today' | 'sleeping'> & {
    stop_reason?: CloudMachine['stop_reason'];
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
  if (machine.sleeping)
    return { resting: true, heading: 'Resting', line: 'Starts when you message an agent.' };
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
