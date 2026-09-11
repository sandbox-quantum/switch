/** Initial room selection is consumed by the persistent SDK host at creation. */
class SessionRoomIntents {
  private readonly rooms = new Map<string, string>();
  noteIntendedRoom(sessionId: string, roomId: string, _roomName: string | null): void {
    this.rooms.set(sessionId, roomId);
  }
  takeSharedIntent(sessionId: string, _agentId: string): { rooms: string[]; startCursor?: number } {
    const room = this.rooms.get(sessionId);
    this.rooms.delete(sessionId);
    return { rooms: room ? [room] : [] };
  }
}
export const switchNotificationPoller = new SessionRoomIntents();
