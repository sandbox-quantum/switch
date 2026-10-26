import type { MachineDetail } from '@shared/core/managed-agents/managed-agents';
import { providerDisplayName } from '@shared/core/providers/agent-provider-registry';

export type MachineTone = 'ok' | 'warning' | 'problem' | 'idle';

/** A short label with its tone, and the sentence behind it for its hover title. */
export type MachineBadge = { label: string; tone: MachineTone; title: string };

const DISCONNECT_REASON: Record<string, string> = {
  socket_closed: 'its controller stopped or lost its connection',
  heartbeat_lapsed: 'its connection stopped responding',
  server_shutdown: 'the Switch server it was connected to restarted',
  server_lost: 'the Switch server it was connected to stopped responding',
  taken_over: 'another instance of its controller took over',
  revoked: 'it was removed',
};

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** Whether the machine is connected, with when it connected or when and why it stopped. */
export function machineConnection(machine: MachineDetail): MachineBadge {
  const connection = machine.connection;
  if (machine.state === 'revoked')
    return {
      label: 'Removed',
      tone: 'idle',
      title: machine.revokedAt ? `Removed from Switch ${when(machine.revokedAt)}.` : 'Removed.',
    };
  if (machine.state === 'unknown' || connection === null)
    return {
      label: 'Never connected',
      tone: 'idle',
      title: 'Has never connected to Switch. It does once its controller is started.',
    };
  if (machine.state === 'online')
    return {
      label: 'Online',
      tone: 'ok',
      title: `Connected since ${when(connection.connectedAt)}.`,
    };
  const why = connection.disconnectReason
    ? (DISCONNECT_REASON[connection.disconnectReason] ?? connection.disconnectReason)
    : null;
  const at = connection.disconnectedAt ? ` ${when(connection.disconnectedAt)}` : '';
  return { label: 'Offline', tone: 'problem', title: `Disconnected${at}${why ? `: ${why}` : ''}.` };
}

/**
 * The last time Switch heard from the machine at all: now while it is
 * connected, else the latest of its status report, its connecting and its
 * going.
 */
export function lastContact(machine: MachineDetail, now: Date): string | null {
  if (machine.state === 'online') return now.toISOString();
  const times = [
    machine.lastSeenAt,
    machine.connection?.connectedAt,
    machine.connection?.disconnectedAt,
  ]
    .filter((time): time is string => typeof time === 'string')
    .sort((a, b) => Date.parse(b) - Date.parse(a));
  return times[0] ?? null;
}

/** What the machine is to this person: this computer, an SSH host of theirs, or how it runs. */
export function machineKindLabel(machine: MachineDetail): string {
  if (machine.local?.kind === 'this-computer') return 'This computer';
  if (machine.local?.kind === 'ssh-host') return `SSH host · ${machine.local.sshHost}`;
  if (machine.cloud) return 'Switch cloud';
  if (machine.kind === 'console') return 'Switch Console';
  return 'Agents controller';
}

const OS_NAMES: Record<string, string> = {
  macos: 'macOS',
  darwin: 'macOS',
  linux: 'Linux',
  windows: 'Windows',
  win32: 'Windows',
};

/** Its operating system, version and architecture, as it reported them; null when it did not. */
export function platformLabel(platform: MachineDetail['platform']): string | null {
  if (!platform) return null;
  const os = OS_NAMES[platform.os.toLowerCase()] ?? platform.os;
  return [platform.osVersion ? `${os} ${platform.osVersion}` : os, platform.arch]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Where the controller stands against the release Switch names for it: on it,
 * updated with Console, or behind and why. Null badge when there is nothing
 * to flag.
 */
export function controllerRelease(machine: MachineDetail): {
  title: string;
  badge: { label: string; tone: MachineTone } | null;
} {
  const release = machine.release;
  if (release === null || release.current)
    return {
      title:
        release !== null
          ? `Runs ${release.wanted}, the release Switch names.`
          : machine.kind === 'console' || machine.updatedBy === 'console'
            ? 'Updates with Switch Console, which runs it.'
            : 'Switch names no controller release for this machine.',
      badge: null,
    };
  const names = `Runs ${machine.version ?? 'an unknown version'}; Switch names ${release.wanted}.`;
  const update = machine.update;
  if (machine.state !== 'online' || !update || update.target !== release.wanted)
    return {
      title: `${names} ${
        machine.state === 'online'
          ? 'It has said nothing about moving to it: a controller older than self-update never does, and needs reinstalling once.'
          : 'It moves to it once it is connected again.'
      }`,
      badge: { label: 'Behind', tone: 'warning' },
    };
  if (update.state === 'waiting_idle')
    return {
      title: `${names} It moves to it once no session is running on it.`,
      badge: { label: 'Updating when idle', tone: 'warning' },
    };
  if (update.state === 'restart_needed')
    return {
      title: `${names} ${update.problem ?? 'It installed it; restart it to run it.'}`,
      badge: { label: 'Restart needed', tone: 'warning' },
    };
  return {
    title: `${names} ${update.problem ?? 'It did not say why.'}`,
    badge: { label: 'Update failed', tone: 'problem' },
  };
}

const KIND_ORDER: Record<string, number> = { 'this-computer': 0, 'ssh-host': 1 };
const STATE_ORDER: Record<MachineDetail['state'], number> = {
  online: 0,
  offline: 1,
  unknown: 2,
  revoked: 3,
};

/**
 * The machines in the order the page lists them, the removed ones apart: this
 * computer first, then its SSH hosts, then the rest, each by whether it is
 * connected and then by name.
 */
export function arrangeMachines(machines: MachineDetail[]): {
  live: MachineDetail[];
  removed: MachineDetail[];
} {
  const rank = (machine: MachineDetail) => KIND_ORDER[machine.local?.kind ?? ''] ?? 2;
  const sorted = [...machines].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
      a.name.localeCompare(b.name)
  );
  return {
    live: sorted.filter((machine) => machine.state !== 'revoked'),
    removed: sorted
      .filter((machine) => machine.state === 'revoked')
      .sort((a, b) => (b.revokedAt ?? '').localeCompare(a.revokedAt ?? '')),
  };
}

/** How full a resource is, as "X free of Y", or null when the machine reported none of it. */
export function resourceLabel(
  free: number,
  total: number,
  format: (bytes: number) => string
): string | null {
  if (total <= 0) return null;
  return `${format(free)} free of ${format(total)}`;
}

/**
 * The machines whose name, description or kind contains `query`, ignoring
 * case. An empty query keeps them all.
 */
export function filterMachines(machines: MachineDetail[], query: string): MachineDetail[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return machines;
  return machines.filter((machine) =>
    [machine.name, machine.description, machineKindLabel(machine)].some((text) =>
      text?.toLowerCase().includes(needle)
    )
  );
}

/**
 * One line saying what the machine is and what it runs, for its row in the
 * list: its kind, its operating system and how many agents are on it.
 */
export function machineSummary(machine: MachineDetail, agentCount: number): string {
  const os = machine.platform
    ? (OS_NAMES[machine.platform.os.toLowerCase()] ?? machine.platform.os)
    : null;
  const agents =
    agentCount === 0 ? 'No agents' : `${agentCount} ${agentCount === 1 ? 'agent' : 'agents'}`;
  return [machineKindLabel(machine), os, agents].filter(Boolean).join(' · ');
}

/** Something about the machine to act on or wait for, shown above its details. */
export type MachineNotice = { key: string; tone: MachineTone; title: string; body: string };

/**
 * What needs saying before the details: that it is offline, removed or never
 * connected, that its controller is behind the release Switch names, and
 * which installed providers cannot run an agent. None for a healthy machine.
 */
export function machineNotices(machine: MachineDetail): MachineNotice[] {
  const connection = machineConnection(machine);
  if (machine.state === 'revoked')
    return [
      {
        key: 'connection',
        tone: 'idle',
        title: 'Removed',
        body: `${connection.title} It no longer runs agents and cannot reconnect.`,
      },
    ];
  const notices: MachineNotice[] = [];
  if (machine.state === 'offline')
    notices.push({
      key: 'connection',
      tone: 'problem',
      title: 'Offline',
      body: `${connection.title} The agents placed on it do not run until it is back.`,
    });
  else if (machine.state === 'unknown' || machine.connection === null)
    notices.push({
      key: 'connection',
      tone: 'idle',
      title: 'Not connected yet',
      body: connection.title,
    });
  const release = controllerRelease(machine);
  if (release.badge)
    notices.push({
      key: 'release',
      tone: release.badge.tone,
      title: `Controller: ${release.badge.label.toLowerCase()}`,
      body: release.title,
    });
  const stuck = machine.providers.filter((p) => !p.ready && p.problem !== 'not installed');
  if (stuck.length > 0)
    notices.push({
      key: 'providers',
      tone: 'warning',
      title:
        stuck.length === 1 ? 'A provider cannot run agents' : 'Some providers cannot run agents',
      body: stuck
        .map((p) => `${providerDisplayName(p.provider) ?? p.provider}: ${p.problem ?? 'not ready'}`)
        .join(' · '),
    });
  return notices;
}

/** How many sessions it runs, against its limit when it enforces one (a limit of 0 means none). */
export function sessionsLabel(resources: NonNullable<MachineDetail['resources']>): string {
  return resources.sessionsMax > 0
    ? `${resources.sessionsRunning} of ${resources.sessionsMax}`
    : `${resources.sessionsRunning}`;
}
