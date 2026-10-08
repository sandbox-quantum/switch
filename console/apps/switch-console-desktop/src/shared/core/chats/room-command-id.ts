/**
 * The command id a room message runs under in an agent's session, as the
 * session host derives it (`roomCommandId` in the agent providers' room
 * prompt): a name-based id from the agent, the room and the message. Computed
 * with Web Crypto so the renderer can bind a session's turn to the room
 * message that started it. The two must stay identical; a test pins it.
 */
export async function roomCommandId(
  agentId: string,
  roomId: string,
  messageId: string
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`switch-room:${agentId}:${roomId}:${messageId}`)
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
