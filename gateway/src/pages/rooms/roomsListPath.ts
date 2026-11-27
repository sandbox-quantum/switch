import { useAuth } from "../../data/AuthContext";
import { gatewayChats } from "../../data/capabilities";

/** Where the person's room list is: Chats' Rooms tab where there are Chats,
 * the Rooms page where there are none. */
export function useRoomsListPath(): string {
  return gatewayChats(useAuth().capabilities).allowed ? "/chats?tab=rooms" : "/rooms";
}
