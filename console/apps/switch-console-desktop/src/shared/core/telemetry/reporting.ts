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
