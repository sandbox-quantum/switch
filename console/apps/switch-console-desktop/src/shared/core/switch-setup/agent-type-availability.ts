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
/**
 * What kind of obstacle it is, in one word, for the tile that has room for one.
 *
 * - `not-installed` — the software is missing and installing it is the fix.
 * - `unsupported` — it cannot run here at all: no session adapter for this
 *   provider, or a platform that cannot host one. Telling someone to install
 *   something is wrong here; there is nothing they could install.
 * - `unknown` — the check itself did not come back. Kept apart from the other
 *   two on purpose: a host that could not be probed has not said the CLI is
 *   missing, and reporting it as missing would invent an answer.
 *
 * The full {@link AgentTypeAvailability.blockedReason} still says which, in
 * full, wherever there is room for a sentence.
 */
export type AgentTypeBlockedKind = 'not-installed' | 'unsupported' | 'unknown';

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
  /** The same verdict in one word, for a tile too small for the sentence.
   * Null exactly when {@link blockedReason} is. */
  blockedKind: AgentTypeBlockedKind | null;
};
