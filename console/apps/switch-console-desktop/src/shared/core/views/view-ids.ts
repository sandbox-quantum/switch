/**
 * Every screen the app can show, by id.
 *
 * The view registry is the real definition, but it cannot be imported here: it
 * holds React components, and this list has to be readable from the main
 * process. So the names are written out once, and the registry asserts at
 * compile time that its own keys are exactly these — adding a view without
 * adding it here fails the build rather than reporting a screen nobody named.
 */
export const VIEW_IDS = [
  'home',
  'location',
  'session',
  'room',
  'settings',
  'server',
  'serverAgents',
  'serverRooms',
  'remoteHosts',
  'remoteHost',
] as const;

export type ViewIdName = (typeof VIEW_IDS)[number];
