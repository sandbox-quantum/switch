import type { InstallMethod } from '@switch-console/core/deps';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import type { HostSetupStepKind } from '@shared/core/remote-hosts/setup';
import type { SearchStatus } from '@shared/core/search';
import type { AppSettingsKeyName } from '@shared/core/settings/setting-keys';
import type { RendererTelemetryEvents } from '@shared/core/telemetry/renderer-events';
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
  | 'already_configured'
  | 'invalid_name'
  /**
   * The two the other way into this — dropping a folder on the sidebar — hits
   * most: the directory holds no agent configuration, or it holds one belonging
   * to an identity this server has never heard of. Both are a person pointing
   * the app at the wrong folder, which is worth telling apart from a fault.
   */
  | 'not_configured'
  | 'agent_not_on_server'
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

/** Installing, updating or removing an agent's own CLI. */
export type TelemetryCliAction = 'install' | 'update' | 'uninstall';

/**
 * How a CLI was installed. The installer capability's own closed set, plus
 * `unspecified` for the callers that do not name one — the parameter is optional
 * on every one of these paths.
 */
export type TelemetryInstallMethod = InstallMethod | 'unspecified';

/**
 * Why installing, updating or removing a CLI failed.
 *
 * The union of the three operations' own error types, which share most of their
 * cases and differ at the ends. `error` covers a throw, which these paths are
 * not supposed to do but can.
 */
export type TelemetryCliFailure =
  | 'none'
  | 'unknown_dependency'
  | 'no_install_command'
  | 'no_update_strategy'
  | 'no_uninstall_strategy'
  | 'no_uninstall_command'
  | 'permission_denied'
  | 'command_failed'
  | 'pty_open_failed'
  | 'not_detected_after_install'
  | 'not_detected_after_update'
  | 'still_present'
  | 'error';

/**
 * Which messaging platform a room or bridge is on.
 *
 * The server names the platform as free text, so this is narrowed at the emitter
 * rather than trusted — the same treatment provider ids get. `other` is a
 * platform we do not know about, `unknown` is one we could not read.
 */
export type TelemetryBridgePlatform =
  | 'slack'
  | 'mattermost'
  | 'discord'
  | 'teams'
  | 'telegram'
  | 'other'
  | 'unknown';

/**
 * What asked for an update check.
 *
 * `startup` and `scheduled` are the app's own; `user` is a menu item or a button
 * somebody pressed. Note a manual check that lands while an automatic one is
 * already running joins it rather than starting a new one, so a small number of
 * user checks are reported under the trigger that got there first.
 */
export type TelemetryUpdateTrigger = 'user' | 'startup' | 'scheduled';

export type TelemetryBridgeFailure = 'none' | 'unauthenticated' | 'forbidden' | 'invalid' | 'error';

export type TelemetryRoomCreateFailure =
  | 'none'
  | 'unauthenticated'
  | 'bridge_unavailable'
  | 'invalid'
  | 'unreachable'
  | 'error';

/** How someone signed in. Not a setting — which of the two forms they used. */
export type TelemetryAuthMethod = 'password' | 'oidc';

/**
 * Why a sign-in failed. `cancelled` is the browser window being closed on the
 * single-sign-on path, which is someone changing their mind rather than a fault.
 */
export type TelemetrySignInFailure =
  | 'none'
  | 'invalid_credentials'
  | 'cancelled'
  | 'failed'
  | 'unreachable';

/** What was done to a step of a remote host's setup. */
export type TelemetryHostSetupAction = 'install' | 'update' | 'skip';

export type TelemetryManagedServerAction = 'start' | 'stop' | 'reset';

export type TelemetryManagedServerFailure =
  | 'none'
  | 'docker_not_installed'
  | 'docker_daemon_down'
  | 'version_downgrade'
  | 'error';

/**
 * Whether Docker was usable.
 *
 * `unknown` is honest rather than lazy: only starting a stack probes for Docker,
 * so stopping or resetting one genuinely does not know, and answering `available`
 * there would be a guess indistinguishable from a reading.
 */
export type TelemetryDockerAvailability = 'available' | 'unavailable' | 'unknown';

/**
 * Which way round agents and rooms were joined.
 *
 * The same operation serves both screens, and one of them loops it once per
 * room — so without this, adding one agent to five rooms is indistinguishable
 * from five separate one-agent adds.
 */
export type TelemetryRoomAgentsDirection = 'agents_to_room' | 'room_to_agents';

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

/** Which setting was changed. The keys of the app's settings, and nothing else. */
export type TelemetrySettingKey = AppSettingsKeyName;

/** How a search ended. The search's own union, reused rather than restated. */
export type TelemetrySearchStatus = SearchStatus;

/** The kinds of server this install can hold. Named once, used by five events. */
export type TelemetryServerKind = 'local' | 'remote_managed' | 'external';

/**
 * A setup step's kind, reused from the remote-host model rather than restated.
 *
 * `unknown` is this catalogue's own addition, not the model's: a step in a plan
 * always has a real kind, but a run that fails before it can build the plan has
 * no step to read one from. Reporting such a failure under a real kind would
 * add it to that kind's tally, and "which step do people get stuck on" is the
 * one question this event exists to answer.
 */
export type TelemetryHostSetupStepKind = HostSetupStepKind | 'unknown';

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
   * The app checked for an update. `trigger` separates a check someone asked for
   * from the hourly one, because only the first says anything about intent.
   */
  update_checked: {
    trigger: TelemetryUpdateTrigger;
    result: 'available' | 'up_to_date' | 'failed';
  };
  update_downloaded: {
    outcome: TelemetryOutcome;
  };
  /**
   * An install was started — not finished.
   *
   * Deliberately named for what it can actually observe. A successful install
   * quits the app, so there is no moment afterwards in which to report one; what
   * this counts is the point the update was handed to the installer. Whether it
   * worked is answered by the next `app_launched` and its version.
   */
  update_install_started: {
    outcome: TelemetryOutcome;
  };
  /** A messaging platform was connected to a server. */
  bridge_connected: {
    bridge_platform: TelemetryBridgePlatform;
    outcome: TelemetryOutcome;
    failure_reason: TelemetryBridgeFailure;
  };
  /**
   * A messaging platform was disconnected from a server.
   *
   * Carries an outcome because the gateway refuses this one routinely — it is
   * admin-only, and a non-admin's attempt returns rather than throws. Without it
   * a refusal is indistinguishable from a disconnection that happened.
   */
  bridge_disconnected: {
    bridge_platform: TelemetryBridgePlatform;
    outcome: TelemetryOutcome;
  };
  /** Someone linked their account on a messaging platform to their Switch user. */
  bridge_identity_claimed: {
    bridge_platform: TelemetryBridgePlatform;
    outcome: TelemetryOutcome;
  };
  /**
   * The connector was updated. `was_reinstall` separates a host with a single
   * update verb from one where the connector must be removed and put back —
   * Codex has no update verb, so for it every update has a window in the middle
   * with nothing installed, and a failure there leaves the agent without one.
   */
  connector_updated: {
    agent_type: TelemetryAgentType;
    target: 'local' | 'remote';
    outcome: TelemetryOutcome;
    was_reinstall: boolean;
  };
  /**
   * The connector was removed. The churn signal.
   *
   * Only ever `local`: there is no remote uninstall anywhere above the service,
   * so a `remote` value here would be one that cannot occur.
   */
  connector_uninstalled: {
    agent_type: TelemetryAgentType;
    target: 'local';
    outcome: TelemetryOutcome;
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
  /**
   * An agent's own CLI was installed, updated or removed — not the Switch
   * connector, which `connector_installed` and friends report.
   *
   * The single biggest wall a new user hits, and until now entirely uncounted.
   */
  agent_cli_action: {
    agent_type: TelemetryAgentType;
    target: 'local' | 'remote';
    install_method: TelemetryInstallMethod;
    action: TelemetryCliAction;
    outcome: TelemetryOutcome;
    failure_reason: TelemetryCliFailure;
  };
  /**
   * A room was created on a server. `bridge_unavailable` is the failure worth
   * watching: it means the messaging platform, not the app, refused.
   */
  room_created: {
    server_kind: TelemetryServerKind;
    bridge_platform: TelemetryBridgePlatform;
    agent_count: number;
    has_instructions: boolean;
    outcome: TelemetryOutcome;
    failure_reason: TelemetryRoomCreateFailure;
  };
  room_deleted: {
    server_kind: TelemetryServerKind;
    outcome: TelemetryOutcome;
  };
  room_agents_added: {
    agent_count: number;
    direction: TelemetryRoomAgentsDirection;
  };
  /** Someone signed in to a server. */
  server_sign_in: {
    auth_method: TelemetryAuthMethod;
    server_kind: TelemetryServerKind;
    outcome: TelemetryOutcome;
    failure_reason: TelemetrySignInFailure;
  };
  server_sign_out: {
    server_kind: TelemetryServerKind;
  };
  /**
   * A step of a remote host's setup was run.
   *
   * A skip is worth counting separately from a failure: it is someone deciding
   * to go on without the thing, which is an abandonment signal rather than a
   * fault.
   */
  host_setup_step: {
    step_kind: TelemetryHostSetupStepKind;
    agent_type: TelemetryAgentType;
    action: TelemetryHostSetupAction;
    outcome: TelemetryOutcome;
  };
  host_onboarded: {
    outcome: TelemetryOutcome;
    /** Whether the host was picked from the machine's SSH config or typed in. */
    picked_from_ssh_config: boolean;
  };
  host_removed: {
    outcome: TelemetryOutcome;
  };
  /**
   * A managed Switch server was started, stopped or reset.
   *
   * Docker missing or refusing is the classic first-run wall, and starting one
   * already probes for it — so the dimension that explains the failure comes
   * free on the path where it matters.
   */
  managed_server_action: {
    action: TelemetryManagedServerAction;
    target: 'local' | 'remote';
    outcome: TelemetryOutcome;
    failure_reason: TelemetryManagedServerFailure;
    docker_available: TelemetryDockerAvailability;
  };
  /**
   * The four events below are reported by the interface, through the one gate in
   * `./renderer-events`. They are here because they are catalogue events like
   * any other — the same consent check, the same property filter — and only the
   * place they are observed differs.
   */
  view_opened: RendererTelemetryEvents['view_opened'];
  command_executed: RendererTelemetryEvents['command_executed'];
  deeplink_opened: RendererTelemetryEvents['deeplink_opened'];
  onboarding_step_started: RendererTelemetryEvents['onboarding_step_started'];
  onboarding_checklist_dismissed: RendererTelemetryEvents['onboarding_checklist_dismissed'];
  onboarding_completed: RendererTelemetryEvents['onboarding_completed'];
  add_server_step: RendererTelemetryEvents['add_server_step'];
  /** A screen failed. A count, with nothing of what failed or where. */
  renderer_crashed: RendererTelemetryEvents['renderer_crashed'];
  /**
   * A setting was changed. **The key only, never the value.** Several settings
   * hold free text — a sound file, a default directory, a font, a browser
   * profile — and the useful question is which settings people touch, which the
   * key answers on its own.
   */
  setting_changed: {
    setting_key: TelemetrySettingKey;
  };
  /**
   * A search ran. Never the query: what is asked for is the user's, and the
   * answerable questions are whether search finds anything and what people open.
   */
  search_performed: {
    /**
     * The search's own outcome union, which already separates the four cases
     * that matter — including a search that failed, which is not the same as one
     * that found nothing.
     */
    status: TelemetrySearchStatus;
    result_count: number;
  };
  /**
   * Consent to share usage data was switched **on**.
   *
   * Only on. Turning it off cannot be reported — the gate is read immediately
   * before every send, so by the time the setting is written the event is
   * already blocked — and reporting a refusal would mean transmitting something
   * from someone at the moment they asked us not to. So the opt-out rate is
   * deliberately unknown rather than obtained that way, and this counts the
   * agreements only. `first_run` is the prompt on first launch; `settings` is
   * someone turning it on later of their own accord.
   */
  telemetry_consent_changed: {
    source: 'first_run' | 'settings';
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
  update_checked: ['trigger', 'result'],
  update_downloaded: ['outcome'],
  update_install_started: ['outcome'],
  bridge_connected: ['bridge_platform', 'outcome', 'failure_reason'],
  bridge_disconnected: ['bridge_platform', 'outcome'],
  bridge_identity_claimed: ['bridge_platform', 'outcome'],
  connector_updated: ['agent_type', 'target', 'outcome', 'was_reinstall'],
  connector_uninstalled: ['agent_type', 'target', 'outcome'],
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
  setting_changed: ['setting_key'],
  search_performed: ['status', 'result_count'],
  agent_cli_action: [
    'agent_type',
    'target',
    'install_method',
    'action',
    'outcome',
    'failure_reason',
  ],
  room_created: [
    'server_kind',
    'bridge_platform',
    'agent_count',
    'has_instructions',
    'outcome',
    'failure_reason',
  ],
  room_deleted: ['server_kind', 'outcome'],
  room_agents_added: ['agent_count', 'direction'],
  server_sign_in: ['auth_method', 'server_kind', 'outcome', 'failure_reason'],
  server_sign_out: ['server_kind'],
  host_setup_step: ['step_kind', 'agent_type', 'action', 'outcome'],
  host_onboarded: ['outcome', 'picked_from_ssh_config'],
  host_removed: ['outcome'],
  managed_server_action: ['action', 'target', 'outcome', 'failure_reason', 'docker_available'],
  view_opened: ['view_id'],
  command_executed: ['command_id', 'invoked_by'],
  deeplink_opened: ['resolved', 'cold_start'],
  onboarding_step_started: ['step_id'],
  onboarding_checklist_dismissed: [],
  onboarding_completed: [],
  add_server_step: ['step', 'choice'],
  renderer_crashed: [],
  telemetry_consent_changed: ['source'],
  session_attached: ['agent_type', 'outcome'],
} as const satisfies { [K in TelemetryEventName]: readonly (keyof TelemetryEventMap[K])[] };

/**
 * Any catalogued property the allow-list above leaves out.
 *
 * The `satisfies` clause constrains what may appear in each array — every entry
 * has to be a real property of that event — but says nothing about what must.
 * A property added to the map and forgotten here therefore compiles, and is
 * dropped at runtime by the emitter: the event still sends, minus a dimension,
 * with nothing to say so. The mechanical walk in `./catalogue.test.ts` cannot
 * catch it either, since it builds its samples from this list.
 */
type UndeclaredProperty = {
  [K in TelemetryEventName]: Exclude<
    keyof TelemetryEventMap[K],
    (typeof TELEMETRY_EVENT_PROPERTIES)[K][number]
  >;
}[TelemetryEventName];

const _everyPropertyIsAllowListed: [UndeclaredProperty] extends [never] ? true : never = true;
void _everyPropertyIsAllowListed;

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
