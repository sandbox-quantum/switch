/** Initial room selection remains available until the persistent SDK host is ready. */
class SessionRoomIntents {
  private readonly rooms = new Map<string, string>();
  noteIntendedRoom(sessionId: string, roomId: string, _roomName: string | null): void {
    this.rooms.set(sessionId, roomId);
  }
  clearSharedIntent(sessionId: string): void {
    this.rooms.delete(sessionId);
  }
  getSharedIntent(sessionId: string, _agentId: string): { rooms: string[]; startCursor?: number } {
    const room = this.rooms.get(sessionId);
    return { rooms: room ? [room] : [] };
  }
}
export const switchNotificationPoller = new SessionRoomIntents();
