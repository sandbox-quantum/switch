/**
 * Dimensions the UI supplies to reported events.
 *
 * They live here, rather than in the telemetry module, because the renderer has
 * to name them at the point the user acts and the main process has to put them
 * in a payload — and neither may import the other's internals. Both the union
 * and the value list are exported: the union types the call sites, and the list
 * is what the renderer boundary checks a received value against, since a type
 * proves nothing about a value that crossed a process.
 *
 * Every value is a closed literal. Nothing here may become a `string`.
 */

/**
 * Which control the user reached an action from.
 *
 * Each variant is a real place in the UI that opens the relevant dialog, so a
 * value that stops being reachable shows up as a count that falls to zero rather
 * than as one nobody can place. `unknown` covers a path that did not say — a
 * machine-initiated action, or a caller added without one.
 */
export const UI_ENTRY_POINTS = [
  'command_palette',
  'sidebar',
  'server_page',
  'onboarding',
  'agent_page',
  'session_list',
  'room_row',
  'unknown',
] as const;

export type UiEntryPoint = (typeof UI_ENTRY_POINTS)[number];

/**
 * Who started a session: this app, or an agent already running on a remote host
 * that the app discovered and adopted.
 *
 * The two are not comparable, so they are kept apart rather than summed. An
 * adopted session is stamped when the app *noticed* it — which is when the app
 * next ran, not when the agent started — and two installs watching one host each
 * adopt and report the same session. Separating them means the honest number is
 * still recoverable instead of being quietly inflated.
 */
export const SESSION_START_SOURCES = ['user', 'adopted'] as const;

export type SessionStartSource = (typeof SESSION_START_SOURCES)[number];

/**
 * What asked for a session to be provisioned.
 *
 * `initial` is the first attempt for a session and is not reported — only a
 * retry answers "did it work the second time". The other two are both retries
 * of a session that is already sitting there unprovisioned: `retry_button` is
 * someone pressing it, `auto` is the view trying again on its own when the
 * session is opened. They are counted apart because only the first is intent.
 */
export const SESSION_PROVISION_TRIGGERS = ['initial', 'auto', 'retry_button'] as const;

export type SessionProvisionTrigger = (typeof SESSION_PROVISION_TRIGGERS)[number];

/**
 * What removed an agent: a person, or a server teardown sweeping every agent on
 * it. Declared here for the same reason as the rest — the renderer names it.
 */
export const AGENT_REMOVE_TRIGGERS = ['user', 'server_teardown'] as const;

export type AgentRemoveTrigger = (typeof AGENT_REMOVE_TRIGGERS)[number];

/** Which way round agents and rooms were joined. */
export const ROOM_AGENTS_DIRECTIONS = ['agents_to_room', 'room_to_agents'] as const;

export type RoomAgentsDirection = (typeof ROOM_AGENTS_DIRECTIONS)[number];

/** What asked for an update check. */
export const UPDATE_TRIGGERS = ['user', 'startup', 'scheduled'] as const;

export type UpdateTrigger = (typeof UPDATE_TRIGGERS)[number];
