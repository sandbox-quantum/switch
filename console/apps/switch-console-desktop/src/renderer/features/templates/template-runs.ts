import type { TemplateRun, TemplateRunRoom } from '@main/core/switch-servers/gateway-client';

export function formatTimeAgo(ms: number): string {
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** One line of a run's room tree: the room and how far it sits below the root. */
export type RunTreeRow = { room: TemplateRunRoom; depth: number };

/**
 * A run's rooms in tree order: each room followed by the rooms created from
 * it, siblings in the order the server listed them (creation order).
 *
 * A room whose parent is not in the list (the server left it out, or it was
 * created before the parent was recorded) is drawn at the top level rather
 * than dropped, so every room the run reports gets a line.
 */
export function runRoomTree(rooms: readonly TemplateRunRoom[]): RunTreeRow[] {
  const ids = new Set(rooms.map((r) => r.id));
  const children = new Map<string, TemplateRunRoom[]>();
  const tops: TemplateRunRoom[] = [];
  for (const room of rooms) {
    const parent = room.parentRoomId;
    if (parent !== null && parent !== room.id && ids.has(parent)) {
      const list = children.get(parent) ?? [];
      list.push(room);
      children.set(parent, list);
    } else {
      tops.push(room);
    }
  }
  const rows: RunTreeRow[] = [];
  const seen = new Set<string>();
  const visit = (room: TemplateRunRoom, depth: number) => {
    if (seen.has(room.id)) return;
    seen.add(room.id);
    rows.push({ room, depth });
    for (const child of children.get(room.id) ?? []) visit(child, depth + 1);
  };
  for (const room of tops) visit(room, 0);
  // Rooms only reachable through a loop of parents have no top to hang from.
  // Draw them at the top level so none go missing.
  for (const room of rooms) visit(room, 0);
  return rows;
}

/** What a run row is called: the template it came from, or else its first room. */
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

/** Whether the run can still change, so its row is worth refreshing. */
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
