import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';

/**
 * Where the thing being reported ran: this machine, or an SSH host.
 *
 * `unknown` is sent rather than guessed when the record that would say has gone
 * — a wrong answer here would be indistinguishable from a real one.
 */
export type TelemetryLocationKind = 'local' | 'remote' | 'unknown';

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
    agent_type: AgentProviderId;
    location: TelemetryLocationKind;
  };
  session_started: {
    agent_type: AgentProviderId;
    location: TelemetryLocationKind;
  };
  /**
   * A session finished. `normal` is a session the user ended (deleted or
   * archived); `failed` is one whose agent process died and could not be
   * recovered. A session still running when the app quits reports neither.
   *
   * An `unknown` agent type is a session this run never saw start — the app was
   * restarted while it was live.
   */
  session_ended: {
    agent_type: AgentProviderId | 'unknown';
    location: TelemetryLocationKind;
    outcome: 'normal' | 'failed';
  };
  server_added: {
    /** `external` is a server the user registered by URL: Switch Console does not run it. */
    server_kind: 'local' | 'remote_managed' | 'external';
  };
  connector_installed: {
    agent_type: AgentProviderId;
    target: TelemetryLocationKind;
    outcome: 'success' | 'failure';
  };
};

export type TelemetryEventName = keyof TelemetryEventMap;
