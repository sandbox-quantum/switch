/** Switch agent-name charset, enforced server-side too by `_VALID_NAME_RE` in
 * `core/switch_core/bridges/agent/protocol/service.py`: lowercase letters,
 * digits, `.`, `-`, `_`, starting with a letter or digit. */
export const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** Past this there is nothing to suggest. The trailing-separator strip below
 * backtracks quadratically over a long run of separators, and an agent name is
 * short — so a longer string is refused rather than bounded, which would offer
 * back a quietly shortened name. */
const MAX_SLUG_INPUT = 128;

/**
 * Slugify a string into the agent-name charset, so that what comes back either
 * matches `AGENT_NAME_PATTERN` or is empty. That is the invariant the two are
 * kept in one module for: the name field offers a slug to repair a name the
 * pattern rejected, so a slug the pattern also rejects would re-offer the same
 * error.
 *
 * Leading and trailing `.` and `_` go the way of `-`, since the pattern wants a
 * letter or digit first and a name ending in a separator reads as truncated.
 *
 * Each connector plugin's `configure` skill documents this rule for agents that
 * register without Switch Console; keep them in step.
 */
export function slugifyAgentNamePart(value: string): string {
  if (value.length > MAX_SLUG_INPUT) return '';
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');
}
