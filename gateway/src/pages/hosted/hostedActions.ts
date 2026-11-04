import { ApiError } from "../../data/api";

/** The same limit and hint as the admin's switch dialog (W1's
 * `HostedSwitchDialog`): one rule for every reason box (copy file). */
export const REASON_LIMIT = 500;
export const REASON_HINT = "Don't include names, messages or secrets. Up to 500 characters.";

export type HostedAction = "pause" | "resume" | "restart";

interface Wording {
  button: string;
  whatHappens: string;
  whatTheySee: string;
  placeholder: string;
}

/** Word for word from the copy file's "shared confirm dialog" table. */
export const WORDING: Record<HostedAction, Wording> = {
  pause: {
    button: "Pause user",
    whatHappens:
      "Their box stops now, keeping its disk, and their AI access is cut off straight away. Their agents can't start until you resume them. Messages sent while paused aren't kept.",
    whatTheySee: "Paused by Switch · Contact your admin",
    placeholder: "Why are you pausing this user?",
  },
  resume: {
    button: "Resume user",
    whatHappens: "Their agents can start again. Their next message starts the box.",
    whatTheySee: "Their usual states",
    placeholder: "Why are you resuming this user?",
  },
  restart: {
    button: "Restart box",
    whatHappens:
      "The box restarts, keeping its disk and conversations. A reply in progress is cut off, and they're told to send it again. Usually back within a minute.",
    whatTheySee: "Back in a moment · Starting your cloud",
    placeholder: "Why are you restarting this box?",
  },
};

/** A keyed id shown in three groups after its prefix ("k1-6d2c 91f0 3ab2"),
 * enough to tell two people apart. Display only: actions send the full id. */
export function groupedId(keyedId: string): string {
  const match = /^([a-z0-9]+-)([0-9a-f]+)$/.exec(keyedId);
  if (!match) return keyedId;
  const groups = match[2].slice(0, 12).match(/.{1,4}/g) ?? [];
  return match[1] + groups.join(" ");
}

export function title(
  action: HostedAction,
  userKeyedId: string,
  boxKeyedId: string | null,
): string {
  const user = groupedId(userKeyedId);
  if (action === "restart" && boxKeyedId !== null)
    return `Restart box ${groupedId(boxKeyedId)} for ${user}?`;
  return `${action === "pause" ? "Pause" : "Resume"} user ${user}?`;
}

/** One fixed line per refusal. The server's own text is never shown, so no
 * reason, id or server wording comes back through an error. */
// Core's fixed 503 detail when the operator limits' lock is busy (rate limit
// v1.1+). Matched exactly to pick our own line; it's never shown.
const BUSY_DETAIL = "Operator actions are busy. Try again in a minute.";

export function refusal(error: unknown): string {
  const status = error instanceof ApiError ? error.status : 0;
  if (status === 503 && error instanceof ApiError && error.detail === BUSY_DETAIL) {
    return "Switch is busy right now. Try again in a minute.";
  }
  switch (status) {
    case 401:
      return "Your session has ended. Sign in again.";
    case 403:
      return "Only Switch operators can do this.";
    case 404:
      return "That user or box wasn't found. Reload the list.";
    case 409:
      return "This box can't be restarted right now. Reload the list to see its current state.";
    case 422:
      return "The reason wasn't accepted. Use up to 500 characters, with no names, messages or secrets.";
    case 429:
      return "You've reached the hourly limit for operator actions. Try again later.";
    case 503:
      return "Hosted agents aren't managed on this server.";
    default:
      return "That didn't go through. Reload the list and check the box's state before trying again.";
  }
}
