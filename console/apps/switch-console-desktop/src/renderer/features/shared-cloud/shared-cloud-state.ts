import type { CloudMachine } from '@shared/core/cloud-agents/cloud-agents';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import type {
  IsolationResult,
  RoomBand,
  SharedCloudAgent,
  SharedCloudAgentState,
} from '@shared/core/shared-cloud/shared-cloud';

/** `off`: turned off by an admin, grey rather than red (visibility V2, the copy). */
export type SharedCloudTone = 'working' | 'idle' | 'waking' | 'resting' | 'problem' | 'off';

export type SharedCloudPresentation = {
  label: string;
  /** What the state means for the person, in one line. */
  detail: string;
  tone: SharedCloudTone;
  /** "last reply 4 min ago", or null when it has never replied or is replying now. */
  when: string | null;
};

/**
 * What a person reads for an agent on the shared cloud. "Resting" rather than
 * "parked": to a person "parked" sounds switched off, and the second line sets
 * the expectation that matters, which is a few seconds. A failure never
 * passes for resting.
 */
export function sharedCloudPresentation(
  agent: SharedCloudAgent,
  now: Date,
  /** Your cloud shows the box as Stopped (`boxShowsStopped`): a resting agent
   * on it won't start when messaged, so it reads Stopped (PM review). */
  boxStopped = false
): SharedCloudPresentation {
  const when =
    agent.state === 'working' || !agent.last_reply_at
      ? null
      : `last reply ${replyAgo(agent.last_reply_at, now)}`;
  switch (agent.state) {
    case 'working':
      return {
        label: 'Working',
        detail: agent.room_name ? `Replying in ${agent.room_name}` : 'Replying now',
        tone: 'working',
        when,
      };
    case 'idle':
      return { label: 'Idle', detail: 'Replies straight away', tone: 'idle', when };
    case 'waking':
      return {
        label: 'Back in a moment',
        detail: agent.box_starting
          ? 'Starting your cloud'
          : agent.waiting_for_room
            ? 'Waiting for room'
            : 'Starting up',
        tone: 'waking',
        when,
      };
    case 'resting':
      if (boxStopped)
        return { label: 'Stopped', detail: 'Start your cloud to use it', tone: 'resting', when };
      return {
        label: 'Resting',
        detail: agent.box_stopped ? 'Starts when messaged' : 'Wakes when you message it',
        tone: 'resting',
        when,
      };
    case 'unavailable':
      // Visibility V2: the two new card states, each with its own label (the copy).
      if (agent.paused)
        return { label: 'Paused by Switch', detail: 'Contact your admin', tone: 'problem', when };
      if (agent.turned_off)
        return {
          label: 'Turned off by your admin',
          detail: 'Ask your admin to turn it on',
          tone: 'off',
          when,
        };
      if (agent.stop_reason === 'daily_cap_reached')
        return {
          label: "Can't reply right now",
          detail: "Today's AI limit reached",
          tone: 'problem',
          when,
        };
      if (agent.stop_reason === 'budget_reached')
        return {
          label: "Can't reply right now",
          detail: agent.reset_at
            ? `Budget reached, resets ${resetDate(agent.reset_at)}`
            : 'Budget reached',
          tone: 'problem',
          when,
        };
      if (agent.stop_reason === 'login_needed')
        return {
          label: "Can't reply right now",
          // V3b: after a repair, until a Console has acted on the re-seal (the designer's copy).
          detail: agent.repair_finishing
            ? "Finishing your cloud's repair. Open Switch Console on your computer."
            : // One reason covers a missing login and one the box couldn't sign in with,
              // so the words fit both (the PM's table; splitting them is on the later list).
              'Check your AI login',
          tone: 'problem',
          when,
        };
      if (agent.stop_reason === 'cant_reach')
        return {
          label: "Can't reply right now",
          detail: "Can't reach your cloud",
          tone: 'problem',
          when,
        };
      return {
        label: "Can't reply right now",
        // A host that gave up stays down until its owner restarts it, so
        // "try again" would send the person round in circles (B48).
        detail: agent.needs_restart
          ? 'Needs a restart'
          : agent.memory_stopped
            ? 'Stopped: used too much memory'
            : agent.needs_check
              ? 'Open it to see why'
              : 'Try again in a few minutes',
        tone: 'problem',
        when,
      };
  }
}

export const SHARED_CLOUD_STATE_ORDER: SharedCloudAgentState[] = [
  'working',
  'idle',
  'waking',
  'resting',
  'unavailable',
];

/** A budget's reset as a short date, in the person's own time: "12 Nov". */
function resetDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** "3.5 of 16 GB", from bytes, to one decimal place. */
export function gigabytes(bytes: number): string {
  const value = bytes / 1024 ** 3;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} GB`;
}

export function isolationText(result: IsolationResult): string {
  if (result === 'pass') return 'Yes';
  if (result === 'fail') return 'No';
  return 'Not checked yet';
}

export type AdminTab = 'overview' | 'users' | 'machines' | 'isolation' | 'alerts';

export const ADMIN_TABS: { value: AdminTab; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'users', label: 'Users' },
  { value: 'machines', label: 'Machines' },
  { value: 'isolation', label: 'Isolation' },
  { value: 'alerts', label: 'Alerts' },
];

/** What a workspace admin reads for the room left: rounded, so it shows nothing of other workspaces. */
export const ROOM_BAND: Record<RoomBand, { label: string; note: string }> = {
  plenty: { label: 'Plenty', note: 'room for more people and agents' },
  limited: { label: 'Limited', note: 'Switch is adding room' },
  full: { label: 'Full', note: 'new agents wait until there is room' },
  unknown: { label: 'Unknown', note: "can't reach the machines right now" },
};

/** The sum, or null when any part is unknown: a partial total would read as a real one. */
export function sumKnown(values: (number | null)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null) return null;
    total += value;
  }
  return total;
}

/**
 * How long ago, always in the same style: "just now", "4 min ago", "2 h ago",
 * "yesterday", "3 days ago". One style, so a row of agents reads evenly.
 */
export function replyAgo(iso: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/**
 * Whether the shared cloud's state replaces the agent's usual status line.
 * Only for what is new on shared machines: resting, waking, and a resume that
 * failed. A working or idle agent reads as it does everywhere else.
 */
export function showsSharedCloudState(agent: SharedCloudAgent): boolean {
  return agent.state === 'resting' || agent.state === 'waking' || agent.state === 'unavailable';
}

/**
 * A managed agent's shared-cloud state from what its controller reports about
 * its session: parked reads as Resting, waking as Back in a moment. On a
 * shared-cloud box (`onSharedBox`), a host its controller gave up on (process
 * `failed`, reason `internal`) reads as Can't reply right now · Needs a
 * restart, rather than today's "Failed"; a failed host with any other reason
 * reads as Can't reply right now · Open it to see why. A conversation waiting
 * for room in a full box reads as Back in a moment · Waiting for room. When
 * the box (`box`, its cloud machine) is stopped after a quiet spell, every
 * agent reads Resting · Starts when messaged, and Back in a moment · Starting
 * your cloud while it starts again. Null
 * when there is nothing new to show, so the card keeps its usual status: the
 * session is loaded, or the controller doesn't report it at all. Off the
 * shared cloud a failure keeps today's wording, as prod has it.
 */
export function sharedCloudFromSession(
  agent: ManagedAgentView,
  onSharedBox = false,
  box:
    | (Pick<CloudMachine, 'state' | 'desired_state' | 'sleeping'> &
        Partial<Pick<CloudMachine, 'reseal_providers'>>)
    | null = null,
  /** V3b: whether this Console has already run the re-seal for the box's current controller. */
  resealActed = false
): SharedCloudAgent | null {
  // Visibility V2: the server's reason comes first where it changes the card. Waiting too long, a restart and a
  // move keep the card's usual state (the copy: "then today's state"); the Status panel shows them.
  const reason = onSharedBox ? (agent.stopReason ?? null) : null;
  // A box asleep or starting has its controller offline on purpose: its usual Resting or Back in a moment wins
  // over a can't-reach that arrived before the box's own state did (Core skips it too).
  const boxOffline =
    box !== null && (box.sleeping || (box.desired_state === 'running' && box.state !== 'ready'));
  if (reason && agent.desiredState !== 'stopped' && !(reason.code === 'cant_reach' && boxOffline)) {
    if (reason.code === 'paused_by_switch')
      return {
        agent_id: agent.agentId,
        state: 'unavailable',
        paused: true,
        stop_reason: reason.code,
      };
    if (reason.code === 'turned_off_by_admin')
      return {
        agent_id: agent.agentId,
        state: 'unavailable',
        turned_off: true,
        stop_reason: reason.code,
      };
    if (reason.code === 'login_needed' && (box?.reseal_providers ?? []).length > 0 && !resealActed)
      return {
        agent_id: agent.agentId,
        state: 'unavailable',
        stop_reason: reason.code,
        repair_finishing: true,
      };
    if (
      reason.code === 'login_needed' ||
      reason.code === 'cant_reach' ||
      reason.code === 'daily_cap_reached' ||
      reason.code === 'budget_reached'
    )
      return {
        agent_id: agent.agentId,
        state: 'unavailable',
        stop_reason: reason.code,
        reset_at: reason.resetAt,
      };
    if (reason.code === 'memory_guard')
      return {
        agent_id: agent.agentId,
        state: 'unavailable',
        memory_stopped: true,
        stop_reason: reason.code,
      };
  }
  if (
    onSharedBox &&
    agent.status?.process === 'failed' &&
    agent.desiredState !== 'stopped' &&
    agent.machine?.state === 'online'
  )
    // The controller reports reason `internal` when it gave up restarting the
    // host (B48): a restart is what clears it. Any other reason is the
    // machine's to explain, so the owner is sent to the agent's page.
    return agent.status.reason === 'internal'
      ? { agent_id: agent.agentId, state: 'unavailable', needs_restart: true }
      : { agent_id: agent.agentId, state: 'unavailable', needs_check: true };
  // The box stopped on purpose after a quiet spell (Core's `sleeping`), or
  // starting again after one: never the red "Machine offline" (L2-IS-1).
  if (onSharedBox && box && agent.desiredState !== 'stopped') {
    if (box.sleeping) return { agent_id: agent.agentId, state: 'resting', box_stopped: true };
    // A start that failed: Core leaves it until the owner retries, and its room
    // line asks the owner to check, so the card says the same (never amber).
    if (box.state === 'error')
      return { agent_id: agent.agentId, state: 'unavailable', needs_check: true };
    if (
      box.desired_state === 'running' &&
      box.state !== 'ready' &&
      agent.machine?.state !== 'online'
    )
      return { agent_id: agent.agentId, state: 'waking', box_starting: true };
  }
  // The box's memory guard stopped only this agent; the next message starts it.
  if (
    onSharedBox &&
    agent.status?.process === 'stopped' &&
    agent.status.reason === 'out_of_memory' &&
    agent.desiredState === 'running' &&
    agent.machine?.state === 'online'
  )
    return { agent_id: agent.agentId, state: 'unavailable', memory_stopped: true };
  // A conversation queued in a full box: it starts by itself when room frees.
  if (onSharedBox && (agent.status?.waitingForRoom?.count ?? 0) > 0)
    return { agent_id: agent.agentId, state: 'waking', waiting_for_room: true };
  const session = agent.status?.session;
  if (session === 'parked') return { agent_id: agent.agentId, state: 'resting' };
  if (session === 'waking') return { agent_id: agent.agentId, state: 'waking' };
  return null;
}
