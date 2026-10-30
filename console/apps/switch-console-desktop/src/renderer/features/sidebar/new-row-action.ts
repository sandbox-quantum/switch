/** The row under the Sessions header makes what the list is grouped by: a room in the room view, else a session. */
export function newRowAction(roomMode: boolean): 'New Room' | 'New Session' {
  return roomMode ? 'New Room' : 'New Session';
}
