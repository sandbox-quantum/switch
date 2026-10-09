import {
  ApiError,
  type BridgeDetail,
  type InstalledApp,
  deleteBridge,
  disconnectApp,
  fetchInstalledApps,
} from "../../data/api";

/**
 * Platforms whose app connection holds many chats, each an install of its
 * own, rather than one install per connection. Only the Switch Telegram app's
 * connection has installs; an organisation's own Telegram bot has none, and
 * is deleted as any other connection is.
 */
const CHAT_PLATFORMS = new Set(["telegram"]);

/** Whether `bridge` may hold chats that deleting it disconnects first. */
export function mayHoldChats(bridge: BridgeDetail): boolean {
  return CHAT_PLATFORMS.has(bridge.bridge_type);
}

/** The chats still connected through `bridge`; none for any connection but a
 *  Switch Telegram app's. */
export async function connectedChats(
  bridge: BridgeDetail,
): Promise<InstalledApp[]> {
  if (!mayHoldChats(bridge)) return [];
  const installs = await fetchInstalledApps();
  if (installs === null) {
    throw new Error(
      "Could not read which chats are still connected, so nothing was deleted.",
    );
  }
  return installs.filter(
    (i) => i.bridge_id === bridge.bridge_id && i.status === "active",
  );
}

/**
 * Delete a connection, disconnecting every chat still connected through it
 * first.
 *
 * The server refuses to delete a connection a chat still uses, and ending a
 * chat leaves the connection behind, so a Telegram connection is emptied
 * before it is deleted: the bot leaves each chat, whose room is kept as an
 * internal-only room. A chat already ended elsewhere is skipped. One the bot
 * cannot leave stops it there, with the connection and the chats not yet
 * reached still in place; deleting again carries on. Every other connection
 * is deleted as it always was.
 */
export async function deleteConnection(bridge: BridgeDetail): Promise<void> {
  for (const chat of await connectedChats(bridge)) {
    try {
      await disconnectApp(chat.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) continue;
      throw e;
    }
  }
  await deleteBridge(bridge.bridge_id);
}
