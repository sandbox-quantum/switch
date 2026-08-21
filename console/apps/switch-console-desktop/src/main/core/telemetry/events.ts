import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import type {
  SessionProvisionTrigger,
  SessionStartSource,
  UiEntryPoint,
} from '@shared/core/telemetry/reporting';

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
 * Why removing an agent failed.
 *
 * The path signals failure by throwing rather than by returning a union, so the
 * codes come from the errors' own types: `GatewayError.kind` for the three
 * gateway cases, and a dedicated class for an agent with no identity to delete.
 * `error` is the honest bucket for everything not separated out; widening it
 * means naming a new case, never passing a message through.
 */
export type TelemetryAgentRemoveFailure =
  | 'none'
  | 'not_linked_to_switch'
  | 'gateway_unauthorized'
  | 'gateway_http'
  | 'gateway_network'
  | 'error';

/** Why resetting a remote agent failed. Also named rather than derived. */
export type TelemetryAgentResetFailure =
  | 'none'
  | 'agent_not_found'
  | 'not_remote'
  | 'connect'
  | 'error';

/**
 * What removed an agent.
 *
 * Wiping a managed server deletes every agent on it, through the same function
 * a person uses to delete one. Without this, one click on Reset looks
 * identical to a dozen people giving up on their agents.
 */
export type TelemetryAgentRemoveTrigger = 'user' | 'server_teardown';

/**
 * Which control the user reached the action from, and who started a session.
 *
 * Both are declared in `@shared` because the renderer names them and the main
 * process reports them; see that module for what the variants mean.
 */
export type TelemetryEntryPoint = UiEntryPoint;
export type TelemetrySessionStartSource = SessionStartSource;

/** A retry's trigger, minus `initial`, which is not a retry and is not sent. */
export type TelemetrySessionProvisionTrigger = Exclude<SessionProvisionTrigger, 'initial'>;

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
  /**
   * An agent was removed. `delete_in_switch` says whether its identity on the
   * server went with it, which is the difference between leaving the app and
   * leaving the organisation.
   */
  agent_removed: {
    agent_type: TelemetryAgentType;
    location: TelemetryLocationKind;
    delete_in_switch: boolean;
    trigger: TelemetryAgentRemoveTrigger;
    outcome: TelemetryOutcome;
    failure_reason: TelemetryAgentRemoveFailure;
  };
  /**
   * A remote agent was reset — every one of its panes on the host killed and the
   * agent brought back up. Remote-only, and a real SSH operation, so unlike most
   * of this catalogue it fails for reasons outside the app.
   */
  agent_reset: {
    agent_type: TelemetryAgentType;
    outcome: TelemetryOutcome;
    failure_reason: TelemetryAgentResetFailure;
  };
  /**
   * A server was removed from this install.
   *
   * It carries no count of agents removed with it, because removing a server
   * removes none: it unlinks them. The deletion that does remove them is a
   * separate operation the UI runs first, and nothing on this side sees both —
   * so a count here would always be zero, which reads as an answer.
   */
  server_removed: {
    server_kind: 'local' | 'remote_managed' | 'external';
  };
  /**
   * A session whose setup had not completed was provisioned again.
   *
   * The first attempt for a session is not reported: what is worth knowing is
   * whether a second one worked, and whether anyone had to ask for it.
   */
  session_provision_retried: {
    agent_type: TelemetryAgentType;
    location: TelemetryLocationKind;
    trigger: TelemetrySessionProvisionTrigger;
    outcome: TelemetryOutcome;
  };
  /**
   * A remote session's terminal was attached, or could not be.
   *
   * Reported only for an attach a person waited on. A transport drop cancels
   * every queued attach at once, which is one failure rather than a host's
   * worth, so a cancelled attach is not reported as one.
   */
  session_attached: {
    agent_type: TelemetryAgentType;
    outcome: TelemetryOutcome;
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
  agent_removed: [
    'agent_type',
    'location',
    'delete_in_switch',
    'trigger',
    'outcome',
    'failure_reason',
  ],
  agent_reset: ['agent_type', 'outcome', 'failure_reason'],
  server_removed: ['server_kind'],
  session_provision_retried: ['agent_type', 'location', 'trigger', 'outcome'],
  session_attached: ['agent_type', 'outcome'],
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
