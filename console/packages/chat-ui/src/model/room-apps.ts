/**
 * The rooms a chats sidebar lists: those on no messaging app. A room on Slack,
 * Teams and the like is talked in there, and is reached from its link, its
 * agent's page or the rooms page instead.
 */
export function inAppRooms<T extends { bridgeType: string | null }>(rooms: readonly T[]): T[] {
  return rooms.filter((room) => room.bridgeType === null);
}
