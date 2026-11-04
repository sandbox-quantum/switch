/** The Audit log's words, from the copy doc's W5 section (`0ed32ed1`). */

/** The Action column, and the Action filter's choices. A code not listed
 *  shows as the code itself, in monospace. */
export const ACTION_WORDS: Record<string, string> = {
  "hosted.user_paused": "Paused user",
  "hosted.user_resumed": "Resumed user",
  "hosted.box_restarted": "Restarted box",
  "hosted.machine_drained": "Drained machine",
  "operator.name_revealed": "Showed name",
  "hosted.person_turned_off": "Turned off hosted agents",
  "hosted.person_turned_on": "Turned on hosted agents",
  "hosted.admin_change": "Workspace admin change",
  "budget.created": "Added a limit",
  "budget.updated": "Changed a limit",
  "budget.deleted": "Removed a limit",
  "hosted.box_provision": "Created box",
  "hosted.box_revived": "Brought box back",
  "operator.granted": "Added operator",
  "operator.removed": "Removed operator",
  "alert.raised": "Alert raised",
  "alert.cleared": "Alert cleared",
};

/** The filter's choices, in this order. Core leaves alerts out unless one is
 *  chosen here. A workspace admin's change is filtered as one action, since
 *  Core records all of them as `hosted.admin_change`. */
export const FILTER_ACTIONS = [
  "hosted.user_paused",
  "hosted.user_resumed",
  "hosted.box_restarted",
  "hosted.machine_drained",
  "operator.name_revealed",
  "hosted.admin_change",
  "hosted.box_provision",
  "hosted.box_revived",
  "operator.granted",
  "operator.removed",
  "alert.raised",
  "alert.cleared",
] as const;

export const ANY_ACTION = "Any action";

/** The Result column. Core writes only `done` or `failed` as a result, with
 *  the step reached. */
export const RESULT_PENDING = "In progress";
export const RESULT_DONE = "Done";
/** A done pause whose progress entries include the `partial` step. */
export const RESULT_DONE_PARTIAL = "Done: the box was stopped to cut off AI access";
export const RESULT_FAILED = "Failed";
/** Failed steps with words of their own, for any action. */
export const FAILED_WORDS: Record<string, string> = {
  rate_limited: "Refused: too many actions in a short time",
  not_found: "Failed: no match found",
};
/** Steps a pause, resume, restart or drain reached before it failed, shown
 *  after "Failed at: ". */
export const FAILED_AT = "Failed at: ";
export const STEP_WORDS: Record<string, string> = {
  claimed: "picked up",
  mark: "recording the change",
  revoke: "cutting off AI access",
  clear: "lifting the pause",
  scale: "stopping or starting the box",
  pod_deleted: "restarting the box",
  cordoned: "closing the machine to new boxes",
  finish: "finishing up",
};
/** Box creation's results and steps (V0), shown as the result itself. */
export const PROVISION_WORDS: Record<string, string> = {
  box_not_made: "Failed: the box wasn't created",
  name_refused: "Failed: the box's name was refused",
  policy_refused: "Failed: the cluster's policy refused the box",
  object_refused: "Failed: the cluster refused part of the box",
  box_map_failed: "Failed: couldn't update the box map",
  ceiling_reached: "Failed: the box limit was reached",
  expired: "Expired: not picked up in time",
  unknown: "Result unknown",
};
/** Before the step code, in monospace, for a failed step not listed above. */
export const FAILED_AT_STEP = "Failed at step";

/** The Who column. Operators are named to each other (spec draft 63), with
 *  "(you)" after your own name. Workspace admins appear by keyed id only. */
export const WHO_ADMIN = "Workspace admin";
export const YOU_SUFFIX = " (you)";
/** An operator whose name Core couldn't give (no user row). */
export const WHO_OPERATOR = "Switch operator";
export const WHO_SERVER_SETTINGS = "Server settings";
export const WHO_SWITCH = "Switch";

export const ADMIN_HAS_REASON = "Has a reason (kept in the workspace)";
export const NO_VALUE = "—";

export const ID_PLACEHOLDER = "Box, user or workspace id";
export const LOAD_OLDER = "Load older";
export const EMPTY = "Nothing in the audit log for these filters.";
export const LOAD_ERROR = "Couldn't load the audit log. Reload the page to try again.";

export const TIME_FILTERS: { value: string; label: string; hours: number }[] = [
  { value: "24h", label: "Last 24 hours", hours: 24 },
  { value: "7d", label: "Last 7 days", hours: 24 * 7 },
  { value: "30d", label: "Last 30 days", hours: 24 * 30 },
];

/** The 4-character display form of a keyed id ("k1-6d2c"), with the full id
 *  kept for a tooltip. Anything not shaped like a keyed id shows as it is. */
export function shortId(id: string): string {
  const match = /^(k\d{1,3}-)([0-9a-f]{4})[0-9a-f]{8,}$/.exec(id);
  return match ? `${match[1]}${match[2]}` : id;
}
