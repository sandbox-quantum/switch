/** How the rooms a resource is in that the viewer may not read are shown to
 * whoever manages it: counted, never named. */
export function privateRoomsLabel(count: number): string {
  return `${count} private room${count === 1 ? "" : "s"} you can't open`;
}
