/** The key for rooms that live in Switch itself rather than on a messaging app. */
export const SWITCH_APP = 'switch';

const LABELS: Record<string, string> = {
  [SWITCH_APP]: 'Switch',
  slack: 'Slack',
  mattermost: 'Mattermost',
  discord: 'Discord',
  teams: 'Teams',
  telegram: 'Telegram',
};

/** Which app a room is on: its messaging app, or {@link SWITCH_APP} when it has none. */
export function roomApp(room: { bridgeType: string | null }): string {
  return room.bridgeType ?? SWITCH_APP;
}

export function appLabel(app: string): string {
  return LABELS[app] ?? app.charAt(0).toUpperCase() + app.slice(1);
}

/** The apps these rooms are on: Switch first, then the messaging apps by name. */
export function appsOf(rooms: readonly { bridgeType: string | null }[]): string[] {
  const apps = [...new Set(rooms.map(roomApp))];
  return apps.sort(
    (a, b) =>
      Number(b === SWITCH_APP) - Number(a === SWITCH_APP) || appLabel(a).localeCompare(appLabel(b))
  );
}

/**
 * The rooms on `app`; all of them when `app` is null or none is on it (a
 * choice that outlived its last room must not leave the list empty).
 */
export function inApp<T extends { bridgeType: string | null }>(
  rooms: readonly T[],
  app: string | null
): T[] {
  if (app === null || !rooms.some((room) => roomApp(room) === app)) return [...rooms];
  return rooms.filter((room) => roomApp(room) === app);
}
