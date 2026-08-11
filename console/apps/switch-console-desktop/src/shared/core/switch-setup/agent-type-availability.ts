/**
 * Whether an agent type can be onboarded here, and if not, why (CHOO-1809).
 *
 * The picker used to be handed only the usable types. That made "this type is
 * not set up on this host" indistinguishable from "this type does not exist" —
 * the dropdown simply had fewer rows and said nothing about the difference. A
 * user with Codex installed locally and not on the host they were targeting saw
 * it silently vanish.
 *
 * Carrying the blocked types along with their reason lets the picker show the
 * whole roster, grey out what cannot be chosen, and say what would make it
 * choosable.
 */
export type AgentTypeAvailability = {
  agentId: string;
  /** True only when this type can be onboarded here right now. */
  available: boolean;
  /**
   * Why it cannot be, in words fit to show a user. Null when it can.
   *
   * Always set when `available` is false — an option greyed out for no stated
   * reason is the silence this type exists to remove.
   */
  blockedReason: string | null;
};
