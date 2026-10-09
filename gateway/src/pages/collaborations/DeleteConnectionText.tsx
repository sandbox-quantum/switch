import { DialogContentText } from "@mui/material";
import { useEffect, useState } from "react";
import type { BridgeDetail } from "../../data/api";
import { connectedChats, mayHoldChats } from "./deleteConnection";

/**
 * What deleting a connection does, for its confirmation.
 *
 * Deleting takes every room on the connection with it — except on a Switch
 * Telegram app connection, whose chats are disconnected first and keep their
 * rooms. Which of the two applies is only known once its chats have been
 * counted, so until then this says it is checking rather than warn about the
 * wrong thing.
 */
export default function DeleteConnectionText({ bridge }: { bridge: BridgeDetail }) {
  const holdsChats = mayHoldChats(bridge);
  const [chats, setChats] = useState<number | null>(holdsChats ? null : 0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!holdsChats) return;
    let current = true;
    connectedChats(bridge)
      .then((found) => {
        if (current) setChats(found.length);
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [bridge, holdsChats]);

  const rooms = (
    <>
      This will also delete all {bridge.room_count} associated room
      {bridge.room_count === 1 ? "" : "s"} and external users.
    </>
  );

  if (failed) {
    return (
      <DialogContentText>
        Could not check which chats are still connected through &quot;
        {bridge.display_name}&quot;. Deleting it disconnects each of them
        first, keeping their rooms as internal-only rooms.
      </DialogContentText>
    );
  }
  if (chats === null) {
    return <DialogContentText>Checking which chats are still connected…</DialogContentText>;
  }
  if (chats === 0) {
    return (
      <DialogContentText>
        Are you sure you want to delete &quot;{bridge.display_name}&quot; (
        {bridge.bridge_type})? {rooms}
      </DialogContentText>
    );
  }
  return (
    <DialogContentText>
      {chats === 1 ? "1 chat is" : `${chats} chats are`} still connected through
      &quot;{bridge.display_name}&quot;. Deleting it disconnects{" "}
      {chats === 1 ? "it" : "each of them"} first: the bot leaves, and the
      chat&apos;s room is kept as an internal-only room, reachable only from
      inside Switch. Then the connection is deleted, which turns Telegram off
      for this organisation.
    </DialogContentText>
  );
}
