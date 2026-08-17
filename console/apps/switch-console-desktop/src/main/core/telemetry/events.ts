import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';

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
 * Every event the app may send, and everything each one may carry.
 *
 * The property types are the enforcement, not documentation: literal unions and
 * numbers only, so a caller cannot reach a payload with a path, a name, an
 * error message or anything else free-text. Adding a `string` here removes that
 * guarantee for the whole catalogue — add a union of the values you mean.
 *
 * The ambient fields every event carries — app version, operating system, build
 * channel, install id — are added by the emitter and are not repeated here.
 *
 * Keep this set small. It exists to answer "is the app used, and where does it
 * break"; a question the current set cannot answer is the bar for adding to it,
 * and it is far easier to add an event than to take one away once dashboards
 * depend on it.
 */
export type TelemetryEventMap = {
  /** The app started. Its interesting fields are the ambient ones. */
  app_launched: Record<string, never>;
  agent_created: {
    agent_type: TelemetryAgentType;
    location: TelemetryLocationKind;
  };
  session_started: {
    agent_type: TelemetryAgentType;
    location: TelemetryLocationKind;
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
  server_added: {
    /** `external` is a server the user registered by URL: Switch Console does not run it. */
    server_kind: 'local' | 'remote_managed' | 'external';
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
  agent_created: ['agent_type', 'location'],
  session_started: ['agent_type', 'location'],
  session_ended: ['agent_type', 'location', 'outcome'],
  server_added: ['server_kind'],
  connector_installed: ['agent_type', 'target', 'outcome'],
} as const satisfies { [K in TelemetryEventName]: readonly (keyof TelemetryEventMap[K])[] };
