/**
 * Compose the session's initial prompt, optionally prefixed with an instruction
 * to connect to a Switch room (and assume a role in it). The agent reads this as
 * its first turn, so a natural-language "Connect to the Switch room ..." line
 * drives its `connect_to_room` (and `assume_role`) tool calls before it acts on
 * the user's prompt.
 *
 * A role is only meaningful with a room, so `roleName` is ignored when there is
 * no room. Returns undefined when there is neither a room nor a user prompt (so
 * callers can pass `undefined` for "no initial prompt").
 */
export function buildConnectPrompt(
  roomName: string | null,
  roleName: string | null,
  userPrompt: string
): string | undefined {
  const trimmed = userPrompt.trim();
  if (!roomName) return trimmed || undefined;
  const connect = roleName
    ? `Connect to the Switch room "${roomName}" and assume the "${roleName}" role.`
    : `Connect to the Switch room "${roomName}".`;
  return trimmed ? `${connect}\n\n${trimmed}` : connect;
}
