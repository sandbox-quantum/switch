import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import type { SessionStartSource, UiEntryPoint } from '@shared/core/telemetry/reporting';

/**
 * Where the thing being reported ran: this machine, or an SSH host.
 *
 * `unknown` is sent rather than guessed when the record that would say has gone
 * — a wrong answer here would be indistinguishable from a real one.
 */
export type TelemetryLocationKind = 'local' | 'remote' | 'unknown';

/**
 * Which CLI agent this concerns.
 *
 * `unknown` covers a value that is not one of the registered providers. The
 * column it comes from is typed rather than constrained, so this is checked at
 * the emitter rather than trusted — an unrecognised value is reported as
 * unrecognised and never passed through as free text.
 */
export type TelemetryAgentType = AgentProviderId | 'unknown';

/**
 * Whether the action the event reports completed or failed.
 *
 * Every event that reports an action a user asked for carries this, because an
 * event emitted only on success makes the entire failure population invisible —
 * and a rate nobody can see is worse than no rate at all.
 */
export type TelemetryOutcome = 'success' | 'failure';

/**
 * Why an action failed, as an enumerated code.
 *
 * `none` rather than an absent property on success: every event of a given name
 * then carries the same keys, so a missing value in the data means a send that
 * went wrong rather than an outcome nobody thought about. The variants are the
 * `kind`/`type` discriminants of the failure unions these paths already return,
 * transliterated to snake_case — never a message.
 */
export type TelemetryAgentCreateFailure =
  | 'none'
  | 'unauthenticated'
  | 'name_conflict'
  | 'credentials_conflict'
  | 'invalid_name'
  | 'error';

export type TelemetrySessionStartFailure =
  | 'none'
  | 'agent_not_found'
  | 'already_exists'
  | 'spawn_failed';

/**
 * Which control the user reached the action from, and who started a session.
 *
 * Both are declared in `@shared` because the renderer names them and the main
 * process reports them; see that module for what the variants mean.
 */
export type TelemetryEntryPoint = UiEntryPoint;
export type TelemetrySessionStartSource = SessionStartSource;

/**
 * Every event the app may send, and everything each one may carry.
 *
 * The property types are the enforcement, not documentation: literal unions,
 * numbers and booleans only, so a caller cannot reach a payload with a path, a
 * name, an error message or anything else free-text. Adding a `string` here
 * removes that guarantee for the whole catalogue — add a union of the values you
 * mean.
 *
 * The ambient fields every event carries — app version, operating system, build
 * channel, install id — are added by the emitter and are not repeated here.
 *
 * Keep this set small. It exists to answer "is the app used, and where does it
 * break"; a question the current set cannot answer is the bar for adding to it,
 * and it is far easier to add an event than to take one away once dashboards
 * depend on it.
 */
/**
 * An event with no properties of its own. `Record<never, never>` rather than
 * `Record<string, never>`, whose `keyof` is `string` — which claims every
 * property name, including the ambient ones the emitter adds.
 */
type NoProperties = Record<never, never>;

export type TelemetryEventMap = {
  /** The app started. Its interesting fields are the ambient ones. */
  app_launched: NoProperties;
  agent_created: {
    agent_type: TelemetryAgentType;
    location: TelemetryLocationKind;
    outcome: TelemetryOutcome;
    failure_reason: TelemetryAgentCreateFailure;
    entry_point: TelemetryEntryPoint;
  };
  session_started: {
    agent_type: TelemetryAgentType;
    location: TelemetryLocationKind;
    outcome: TelemetryOutcome;
    failure_reason: TelemetrySessionStartFailure;
    entry_point: TelemetryEntryPoint;
    start_source: TelemetrySessionStartSource;
    /** Whether the session was given something to do at launch. Never the text. */
    has_initial_prompt: boolean;
    /** Whether a Switch room was chosen before the session was created. */
    connected_to_room: boolean;
  };
  /**
   * A session finished. `normal` is a session the user ended (deleted or
   * archived); `failed` is one whose agent process died and could not be
   * recovered. A session still running when the app quits reports neither.
   */
  session_ended: {
    agent_type: TelemetryAgentType;
    location: TelemetryLocationKind;
    outcome: 'normal' | 'failed';
  };
  /**
   * A server was added to this install.
   *
   * `outcome: 'failure'` is reported only for `external` — registering a URL is
   * the one add that is a discrete action able to fail on its own. Bringing up a
   * managed stack fails in ways of its own (no Docker, a version downgrade),
   * which `managed_server_action` reports with the dimension that explains them;
   * counting those here as well would double-count the same wall.
   */
  server_added: {
    /** `external` is a server the user registered by URL: Switch Console does not run it. */
    server_kind: 'local' | 'remote_managed' | 'external';
    outcome: TelemetryOutcome;
  };
  connector_installed: {
    agent_type: TelemetryAgentType;
    target: TelemetryLocationKind;
    outcome: 'success' | 'failure';
  };
};

export type TelemetryEventName = keyof TelemetryEventMap;

/**
 * The properties each event may carry, as data rather than as types alone.
 *
 * The types above are the design; this is what the emitter enforces at runtime.
 * A property that is not named here is dropped before the payload is built, so
 * a field that reaches a call site through a spread — where excess-property
 * checking does not apply — cannot ride along into a payload unnoticed.
 */
export const TELEMETRY_EVENT_PROPERTIES = {
  app_launched: [],
  agent_created: ['agent_type', 'location', 'outcome', 'failure_reason', 'entry_point'],
  session_started: [
    'agent_type',
    'location',
    'outcome',
    'failure_reason',
    'entry_point',
    'start_source',
    'has_initial_prompt',
    'connected_to_room',
  ],
  session_ended: ['agent_type', 'location', 'outcome'],
  server_added: ['server_kind', 'outcome'],
  connector_installed: ['agent_type', 'target', 'outcome'],
} as const satisfies { [K in TelemetryEventName]: readonly (keyof TelemetryEventMap[K])[] };

/** Which events, if any, declare a property the emitter also adds. */
type EventsDeclaringAmbientProperty = {
  [K in TelemetryEventName]: 'build' extends keyof TelemetryEventMap[K] ? K : never;
}[TelemetryEventName];

/**
 * `build` is added to every payload by the emitter, and added last, so an event
 * declaring one of its own would have it silently overwritten. This fails to
 * compile rather than letting that happen quietly.
 */
const _buildIsReserved: [EventsDeclaringAmbientProperty] extends [never] ? true : never = true;
void _buildIsReserved;
