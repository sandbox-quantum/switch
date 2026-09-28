import type { AgentRefusal } from '@main/core/switch-servers/gateway-client';

/** How far back the collapsed row counts refusals: a week. */
export const RECENT_REFUSAL_MS = 7 * 24 * 60 * 60 * 1000;

const OPERATION_LABELS: Record<string, string> = {
  list_templates: 'List templates',
  get_template: 'Read a template',
  run_template: 'Run a template',
  save_template: 'Save a template',
  create_template: 'Save a template',
  update_template: 'Edit a template',
  delete_template: 'Delete a template',
  create_room: 'Create a room',
  create_room_from_yaml: 'Create a room',
};

/**
 * What the agent asked to do, as a short phrase. An operation this Console
 * does not know yet reads as its code with spaces, so a newer server's
 * refusals still show.
 */
export function refusalOperationLabel(operation: string): string {
  const known = OPERATION_LABELS[operation];
  if (known) return known;
  const words = operation.replace(/_/g, ' ').trim();
  if (words.length === 0) return 'A request';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Whether the refusal happened in the last week. An unreadable time counts as older. */
export function isRecentRefusal(refusal: AgentRefusal, now: number = Date.now()): boolean {
  const at = Date.parse(refusal.createdAt);
  return !Number.isNaN(at) && now - at <= RECENT_REFUSAL_MS;
}

/** The refusals split into the last week's and the older ones, each in the order given. */
export function splitRefusals(
  refusals: readonly AgentRefusal[],
  now: number = Date.now()
): { recent: AgentRefusal[]; older: AgentRefusal[] } {
  const recent: AgentRefusal[] = [];
  const older: AgentRefusal[] = [];
  for (const refusal of refusals) {
    if (isRecentRefusal(refusal, now)) recent.push(refusal);
    else older.push(refusal);
  }
  return { recent, older };
}

/** The collapsed row's sentence, e.g. "Your agents were refused 3 requests this week". */
/** How many refusals the server lists at most (`RECENT_REFUSALS` in
 * `core/switch_core/gateway/agent_refusals.py`). A full list may be cut off. */
export const REFUSALS_LISTED = 50;

/**
 * The collapsed line: how many requests agents were refused this week. Not
 * "your agents": an admin sees every agent's. When the server's list came
 * back full and all of it is from this week, there may be more than it says.
 */
export function refusalSummary(count: number, listed: number): string {
  const more = listed >= REFUSALS_LISTED && count === listed;
  const number = more ? `${count} or more` : String(count);
  return `Agents were refused ${number} ${count === 1 && !more ? 'request' : 'requests'} this week`;
}
