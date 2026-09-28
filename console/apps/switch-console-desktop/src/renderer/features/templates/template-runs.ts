import type { TemplateRun } from '@main/core/switch-servers/gateway-client';

export function formatTimeAgo(ms: number): string {
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** What a run is listed as: the template it came from, else its first room. */
export function runLabel(run: TemplateRun): string {
  return run.templateName ?? run.rootRoomName;
}

/**
 * Who made the run's rooms, for the row's "by" line. The agents that created
 * rooms in it, by name, or whoever started it when no agent has: a run with
 * only its root room is a template someone ran.
 */
export function runAuthor(run: TemplateRun): string {
  const names: string[] = [];
  for (const room of run.rooms) {
    const name = room.createdByAgentName;
    if (room.createdByAgentId !== null && name && !names.includes(name)) names.push(name);
  }
  if (names.length === 0) return run.startedByName ?? 'someone';
  if (names.length === 1) return names[0];
  return `${names[0]} and ${names.length - 1} more`;
}

/** Whether the run can still change, so its row is worth refreshing: an idle
 * run starts working again when someone addresses an agent in its rooms. */
export function isLiveRun(run: TemplateRun): boolean {
  return run.state === 'running' || run.state === 'paused';
}

/** Whether the run matches the listing's search text, by its label or any room name. */
export function runMatches(run: TemplateRun, needle: string): boolean {
  if (needle.length === 0) return true;
  return (
    runLabel(run).toLowerCase().includes(needle) ||
    run.rooms.some((r) => r.name.toLowerCase().includes(needle))
  );
}
