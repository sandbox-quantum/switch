/** Switch's agent-name charset: lowercase letters, digits, `.`, `-`, `_`, starting with a letter or digit. */
export const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** Past this there is nothing to suggest: an agent name is short. */
const MAX_SLUG_INPUT = 128;

/**
 * A name folded into the agent-name charset, so that what comes back either
 * matches `AGENT_NAME_PATTERN` or is empty.
 */
export function slugifyAgentName(value: string): string {
  if (value.length > MAX_SLUG_INPUT) return "";
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
}
