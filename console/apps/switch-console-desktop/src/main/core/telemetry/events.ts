import type { InstallMethod } from '@switch-console/core/deps';
import type { ManagedStartFailure } from '@shared/core/managed-switch-server/managed-switch-server';
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
 * Which kind of launch an event belongs to: `new` on an installation's very
 * first launch, `updated` on the first launch after its version changed, and
 * `same` otherwise. Counting `new` counts new installs; `updated`, upgrades.
 */
export type TelemetryInstallKind = 'new' | 'updated' | 'same';

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
  | 'directory_unusable'
  /**
   * The two the other way into this — dropping a folder on the sidebar — hits
   * most: the directory holds no agent configuration, or it holds one belonging
   * to an identity this server has never heard of. Both are a person pointing
   * the app at the wrong folder, which is worth telling apart from a fault.
   */
  | 'not_configured'
  | 'agent_not_on_server'
  /** A managed agent Switch would not place on the machine. */
  | 'refused'
  /** A managed agent whose own fields Switch rejected: its name, description or settings. */
  | 'invalid'
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

/**
 * What removed an agent.
 *
 * Wiping a managed server deletes every agent on it, through the same function
 * a person uses to delete one. Without this, one click on Reset looks
 * identical to a dozen people giving up on their agents.
 */
export type TelemetryAgentRemoveTrigger = 'user' | 'server_teardown';

/**
 * Why an agent its Switch server no longer has was removed from this app:
 * `gone_from_server` when a pass found it deleted there, by anyone, anywhere;
 * `managed_agent_deleted` when the managed agent it had moved to was deleted
 * from this app, which takes the agent it moved from with it.
 */
export type TelemetryAgentPruneCause = 'gone_from_server' | 'managed_agent_deleted';

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
  | 'process_open_failed'
  | 'not_detected_after_install'
  | 'not_detected_after_update'
  | 'still_present'
  | 'error';

/**
 * How long an operation took, in whole milliseconds, on a monotonic clock.
 *
 * A number rather than a value from a fixed set, like `agent_count` and
 * `result_count`, so how to read it matters.
 * Nothing is bucketed and nothing is clamped: take percentiles, not means —
 * some of these legitimately include a password prompt left on screen.
 *
 * Branded so `startTimer()` is the only thing that can mint one. That is what
 * stops a call site reaching for `Date.now() - startedAt`, which is not
 * monotonic and across a clock step yields a negative number nothing at the far
 * end can tell from data.
 */
declare const durationMsBrand: unique symbol;
export type TelemetryDurationMs = number & { readonly [durationMsBrand]: true };

/**
 * An app version, as the app reports its own: semver only, checked where it is
 * minted (`appVersionOf`). Branded so only that check produces one, the way a
 * platform key below is: a string type here would let free text through.
 */
declare const appVersionBrand: unique symbol;
export type TelemetryAppVersion = string & { readonly [appVersionBrand]: true };

declare const platformKeyBrand: unique symbol;

/**
 * Which messaging platform a room or bridge is on.
 *
 * The server names the platform as free text, so this is narrowed at the emitter
 * rather than trusted (see `bridgePlatformOfType`): a platform key a server
 * listed as one of its registered platforms, `other` for a platform we cannot
 * vouch for, `unknown` for one we could not read. Branded so only the narrowing
 * produces one.
 */
export type TelemetryBridgePlatform =
  | 'other'
  | 'unknown'
  | (string & { readonly [platformKeyBrand]: true });

export type TelemetryBridgeFailure = 'none' | 'unauthenticated' | 'forbidden' | 'invalid' | 'error';

/**
 * How linking a messaging account came out. `pending` is a link the server is
 * holding until a one-time code is posted from the account, which counts for
 * nothing yet — reported apart from `success` so the links that are never
 * confirmed stay visible. A server that predates confirming links answers
 * `success` straight away.
 */
export type TelemetryIdentityClaimOutcome = 'success' | 'pending' | 'failure';

/**
 * Which link a confirmation finished. `new` was claimed and waiting on its
 * code, so it follows a `pending` claim; `existing` was made before links had to
 * be confirmed and counted all along. Kept apart so confirmations can be read
 * against the claims that were waiting for them. `unknown` when the caller did
 * not say.
 */
export type TelemetryIdentityLinkKind = 'new' | 'existing' | 'unknown';

/**
 * Why a room create failed. `unreachable` is the server's host known to be
 * down before asking; `network` a request that never reached the server;
 * `forbidden`, `not_found`, `conflict` and `server_error` the server's own
 * answer (403, 404, 409, 5xx); `error` anything with no answer to read.
 */
export type TelemetryRoomCreateFailure =
  | 'none'
  | 'unauthenticated'
  | 'bridge_unavailable'
  | 'invalid'
  | 'unreachable'
  | 'network'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'server_error'
  | 'error';

/** How a room came to be made: the Create room dialog, or a template run. */
export type TelemetryRoomCreateSource = 'dialog' | 'template';

/** How someone signed in. Not a setting — which of the two forms they used. */
export type TelemetryAuthMethod = 'password' | 'oidc' | 'signup';

/**
 * Why a sign-in failed. `cancelled` is the browser window being closed on the
 * single-sign-on path, which is someone changing their mind rather than a fault.
 * `email_taken`, `invalid`, `disabled`, and `rate_limited` are sign-up specific
 * failures; `rate_limited` is the server's cap on sign-ups per hour.
 */
export type TelemetrySignInFailure =
  | 'none'
  | 'invalid_credentials'
  | 'cancelled'
  | 'failed'
  | 'unreachable'
  | 'email_taken'
  | 'invalid'
  | 'disabled'
  | 'rate_limited';

/** What was done to a step of a remote host's setup. */
export type TelemetryHostSetupAction = 'install' | 'update' | 'skip';

export type TelemetryManagedServerAction = 'start' | 'stop' | 'reset';

/**
 * Why a managed server's start, stop or reset failed. The start's own causes
 * are named where the code can tell them apart (`ManagedStartFailure`); `error`
 * is everything else, including anything that threw.
 */
export type TelemetryManagedServerFailure =
  | 'none'
  | 'docker_not_installed'
  | 'docker_daemon_down'
  | 'version_downgrade'
  | 'matrix_migration_failed'
  | Exclude<ManagedStartFailure, 'unexpected'>
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
 * Why adding agents to a room failed. `unreachable` is the server's host known
 * to be down before asking; `unauthenticated` a session the server refused;
 * `network` a request that never reached the server; `forbidden`, `not_found`,
 * `conflict`, `invalid` and `server_error` the server's own answer (403, 404,
 * 409, 400 or 422, 5xx); `error` anything with no answer to read.
 */
export type TelemetryRoomAgentsAddFailure =
  | 'none'
  | 'unreachable'
  | 'unauthenticated'
  | 'network'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'invalid'
  | 'server_error'
  | 'error';

/**
 * Which control the user reached the action from, and who started a session.
 *
 * Both are declared in `@shared` because the renderer names them and the main
 * process reports them; see that module for what the variants mean. A session
 * the app adopted rather than started is `session_discovered`, never a start.
 */
export type TelemetryEntryPoint = UiEntryPoint;
export type TelemetrySessionStartSource = Exclude<SessionStartSource, 'adopted'>;

/**
 * A retry someone asked for. `initial` is not a retry and is not sent, and
 * `auto` is the app's own, sent as `session_reopened`.
 */
export type TelemetrySessionProvisionTrigger = Exclude<SessionProvisionTrigger, 'initial' | 'auto'>;

/**
 * Which setting was changed. The keys of the app's settings, and nothing else,
 * less the two the app writes as it goes rather than a person setting them:
 * `telemetry`, which the first-run notice records the moment it is shown and
 * whose own answer is `telemetry_consent_changed`, and `onboarding`.
 */
export type TelemetrySettingKey = Exclude<AppSettingsKeyName, 'telemetry' | 'onboarding'>;

/** How a search ended. The search's own union, reused rather than restated. */
export type TelemetrySearchStatus = SearchStatus;

/**
 * The kinds of server this install can hold. Named once, used by six events.
 * `cloud` is Switch Cloud, the server this build offers by name; `external` is
 * any other server someone registered by address. `unknown` is a server
 * registered by address while this build names a Cloud whose address it cannot
 * read, so neither of those two could be told apart.
 */
export type TelemetryServerKind = 'local' | 'remote_managed' | 'external' | 'cloud' | 'unknown';

/**
 * Why registering a server by address failed: the address is already another
 * server's, or it answered with a page rather than the server's API (the
 * dashboard's address pasted in place of the server's).
 */
export type TelemetryServerAddFailure =
  | 'none'
  | 'already_added'
  | 'not_the_server_address'
  | 'error';

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
 * channel, install id, the record's own random id and its session — are added
 * by the emitter and are not repeated here.
 *
 * Keep this set small. It exists to answer "is the app used, and where does it
 * break"; a question the current set cannot answer is the bar for adding to it,
 * and it is far easier to add an event than to take one away once dashboards
 * depend on it.
 */
export type TelemetryEventMap = {
  /**
   * The app started, and which kind of launch it was.
   *
   * A launch on a new version after an update is the end of that update, and
   * says so. `from_version` is the version the previous launch ran; `unknown`
   * for an install from before launches were recorded, or a stored value that
   * is not a version. `update_trigger` is `restart_button` when the previous run handed
   * the update to the installer from Restart to update, `other` when the version
   * changed without that (installed when the app quit, or by hand), and
   * `unknown` when that record could not be read. Both are `none` on any launch
   * that is not an upgrade's.
   */
  app_launched: {
    install_kind: TelemetryInstallKind;
    from_version: TelemetryAppVersion | 'unknown' | 'none';
    update_trigger: 'restart_button' | 'other' | 'unknown' | 'none';
  };
  agent_created: {
    agent_type: TelemetryAgentType;
    location: TelemetryLocationKind;
    outcome: TelemetryOutcome;
    failure_reason: TelemetryAgentCreateFailure;
    entry_point: TelemetryEntryPoint;
  };
  /**
   * An agent already set up in a directory on a host was loaded into this app
   * under the Switch identity it already has (Load existing agents). Nothing
   * was created: the agent existed before, set up by another install.
   */
  agent_attached: {
    agent_type: TelemetryAgentType;
    location: TelemetryLocationKind;
  };
  /**
   * An agent's session spawned a subagent, and the app took it on as an agent
   * of its own. Nobody did anything in the app.
   */
  subagent_adopted: {
    agent_type: TelemetryAgentType;
    location: TelemetryLocationKind;
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
   * A session this app found on a host rather than started: the poll that
   * watches each agent's host noticed it, and took it on. That includes a
   * session the room watcher started because the agent was addressed in a
   * room, which the Switch server's own `session_started` counts as it happens.
   * Stamped when the app noticed it, which is when the app next ran, and two
   * installs watching one host each report it. Nobody did anything in the app.
   */
  session_discovered: {
    agent_type: TelemetryAgentType;
    location: TelemetryLocationKind;
  };
  /**
   * A session finished: deleted or archived here, or gone from its host when the
   * app next looked. `outcome` is always `normal`. A session still running when
   * the app quits reports nothing.
   */
  session_ended: {
    agent_type: TelemetryAgentType;
    location: TelemetryLocationKind;
    outcome: 'normal';
  };
  /**
   * A server was added to this install.
   *
   * `outcome: 'failure'` is reported only for a server registered by address
   * (`external` or `cloud`) — registering one is the one add that is a discrete
   * action able to fail on its own. Bringing up a managed stack fails in ways of
   * its own (no Docker, a version downgrade), which `managed_server_action`
   * reports with the dimension that explains them; counting those here as well
   * would double-count the same wall.
   */
  server_added: {
    /**
     * `external` is a server the user registered by URL: Switch Console does not
     * run it. `cloud` is Switch Cloud, registered from its own button or by its
     * address.
     */
    server_kind: TelemetryServerKind;
    outcome: TelemetryOutcome;
    failure_reason: TelemetryServerAddFailure;
  };
  /**
   * Someone asked for an update check, from the menu or a Check button, and
   * how the check came out. One that lands while the app's own check is
   * already running joins it, and reports that check's result. The app's own
   * checks are `update_checked`.
   */
  update_check_requested: {
    result: 'available' | 'up_to_date' | 'failed';
  };
  /**
   * The app checked for an update on its own, as a window loaded (`startup`)
   * or on its hourly timer (`scheduled`), and how the check came out. Not
   * someone using the app (`BACKGROUND_EVENTS`): it is there for the
   * updater's health. One that joins a check already running is not sent;
   * the check it joined already is.
   */
  update_checked: {
    trigger: 'startup' | 'scheduled';
    result: 'available' | 'up_to_date' | 'failed';
  };
  /**
   * Download was pressed for an available update. Downloads only ever start on
   * that press (`autoDownload` is off), so this is the press, and
   * `update_downloaded` is how it ended. Nothing to carry: which update is the
   * event's own app version and the check before it.
   */
  update_download_started: Record<never, never>;
  update_downloaded: {
    outcome: TelemetryOutcome;
  };
  /**
   * An install that was started did not finish: the app never went down for
   * the installer, or the launch after it came back on the old version.
   * Failures only. One that worked is the next launch's `app_launched`, with
   * `install_kind: updated`.
   */
  update_install_started: {
    outcome: 'failure';
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
    outcome: TelemetryIdentityClaimOutcome;
  };
  /**
   * A link was confirmed by posting its one-time code from the account. Only
   * the confirmation screen sees this happen, and the server is asked before it
   * is reported.
   */
  bridge_identity_confirmed: {
    bridge_platform: TelemetryBridgePlatform;
    link_kind: TelemetryIdentityLinkKind;
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
    trigger: TelemetryAgentRemoveTrigger | 'unknown';
    outcome: TelemetryOutcome;
    failure_reason: TelemetryAgentRemoveFailure;
  };
  /**
   * An agent its Switch server no longer has was removed from this app by the
   * pass that keeps the two in step, rather than by a person removing it.
   */
  agent_pruned: {
    agent_type: TelemetryAgentType;
    location: TelemetryLocationKind;
    cause: TelemetryAgentPruneCause;
    outcome: TelemetryOutcome;
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
    server_kind: TelemetryServerKind;
  };
  /**
   * Someone asked for a session whose setup had not completed to be
   * provisioned again: `retry_button` is Retry, `session_click` clicking the
   * session in the sidebar or a session list.
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
   * The app provisioned a session again on its own: the session view opened
   * on one that was not running, typically the screen a launch resumes on.
   */
  session_reopened: {
    agent_type: TelemetryAgentType;
    location: TelemetryLocationKind;
    outcome: TelemetryOutcome;
  };
  /**
   * An agent's own CLI was installed, updated or removed.
   *
   * The single biggest wall a new user hits, and until now entirely uncounted.
   *
   * `duration_ms` matters most here: a CLI install that takes four minutes and
   * one that takes ten seconds are otherwise the same row, and a package manager
   * getting slower is the kind of regression nobody reports because it never
   * fails.
   *
   * A dependency manager that throws instead of returning a result is reported
   * as `error` by `reportedCliAction`, so every attempt is in the denominator.
   */
  agent_cli_action: {
    agent_type: TelemetryAgentType;
    target: 'local' | 'remote';
    install_method: TelemetryInstallMethod;
    action: TelemetryCliAction;
    outcome: TelemetryOutcome;
    failure_reason: TelemetryCliFailure;
    duration_ms: TelemetryDurationMs;
  };
  /**
   * A room was created on a server. `bridge_unavailable` is the failure worth
   * watching: it means the messaging platform, not the app, refused.
   * A template run reports each room it made, and nothing when it fails.
   */
  room_created: {
    server_kind: TelemetryServerKind;
    bridge_platform: TelemetryBridgePlatform;
    agent_count: number;
    has_instructions: boolean;
    outcome: TelemetryOutcome;
    failure_reason: TelemetryRoomCreateFailure;
    source: TelemetryRoomCreateSource;
  };
  room_deleted: {
    server_kind: TelemetryServerKind;
    outcome: TelemetryOutcome;
  };
  room_agents_added: {
    agent_count: number;
    direction: TelemetryRoomAgentsDirection | 'unknown';
    outcome: TelemetryOutcome;
    failure_reason: TelemetryRoomAgentsAddFailure;
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
   * The events from here to `renderer_crashed` are reported by the interface,
   * through the one gate in `./renderer-events`. They are here because they are
   * catalogue events like any other — the same consent check, the same property
   * filter — and only the place they are observed differs.
   */
  view_opened: RendererTelemetryEvents['view_opened'];
  command_executed: RendererTelemetryEvents['command_executed'];
  deeplink_opened: RendererTelemetryEvents['deeplink_opened'];
  add_server_step: RendererTelemetryEvents['add_server_step'];
  onboarding_page: RendererTelemetryEvents['onboarding_page'];
  buddy_step: RendererTelemetryEvents['buddy_step'];
  home_action: RendererTelemetryEvents['home_action'];
  /** A screen failed. A count, with nothing of what failed or where. */
  renderer_crashed: RendererTelemetryEvents['renderer_crashed'];
  /**
   * A setting was changed. **The key only, never the value.** Several settings
   * hold free text — a sound file, a default directory, a font, a browser
   * profile — and the useful question is which settings people touch, which the
   * key answers on its own. Only a write that changed the stored value counts:
   * saving a setting as it already was is not changing it.
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
    /**
     * This launch's kind, so a new install agreeing at first run is one filter;
     * `unknown` when the launch could not be recorded.
     */
    install_kind: TelemetryInstallKind | 'unknown';
  };
};

export type TelemetryEventName = keyof TelemetryEventMap;

/**
 * The events that are not someone using the app: the app noticing, retrying or
 * tidying up on its own, an update that did not install, and a screen that
 * failed. Amplitude counts activity per event name, and these are the names to
 * count as inactive. They carry no session (`flint.session_id` is -1,
 * `./session`) and never start or prolong one. One occurrence of another event
 * that nobody caused is sent the same way with `trackBackgroundEvent`: a
 * session ending because a pass pruned its agent, or the usage-data answer the
 * first-run notice records by itself.
 */
export const BACKGROUND_EVENTS: ReadonlySet<TelemetryEventName> = new Set<TelemetryEventName>([
  'session_discovered',
  'session_reopened',
  'subagent_adopted',
  'agent_pruned',
  'update_checked',
  'update_install_started',
  'renderer_crashed',
]);

/** One event and what it carries, as a union a `switch` on `name` narrows. */
export type TelemetryEvent = {
  [K in TelemetryEventName]: { name: K; properties: TelemetryEventMap[K] };
}[TelemetryEventName];

/**
 * The properties each event may carry, as data rather than as types alone.
 *
 * The types above are the design; this is what the emitter enforces at runtime.
 * A property that is not named here is dropped before the payload is built, so
 * a field that reaches a call site through a spread — where excess-property
 * checking does not apply — cannot ride along into a payload unnoticed.
 */
export const TELEMETRY_EVENT_PROPERTIES = {
  app_launched: ['install_kind', 'from_version', 'update_trigger'],
  agent_created: ['agent_type', 'location', 'outcome', 'failure_reason', 'entry_point'],
  agent_attached: ['agent_type', 'location'],
  subagent_adopted: ['agent_type', 'location'],
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
  session_discovered: ['agent_type', 'location'],
  session_ended: ['agent_type', 'location', 'outcome'],
  server_added: ['server_kind', 'outcome', 'failure_reason'],
  update_check_requested: ['result'],
  update_checked: ['trigger', 'result'],
  update_download_started: [],
  update_downloaded: ['outcome'],
  update_install_started: ['outcome'],
  bridge_connected: ['bridge_platform', 'outcome', 'failure_reason'],
  bridge_disconnected: ['bridge_platform', 'outcome'],
  bridge_identity_claimed: ['bridge_platform', 'outcome'],
  bridge_identity_confirmed: ['bridge_platform', 'link_kind'],
  agent_removed: [
    'agent_type',
    'location',
    'delete_in_switch',
    'trigger',
    'outcome',
    'failure_reason',
  ],
  agent_pruned: ['agent_type', 'location', 'cause', 'outcome'],
  server_removed: ['server_kind'],
  session_provision_retried: ['agent_type', 'location', 'trigger', 'outcome'],
  session_reopened: ['agent_type', 'location', 'outcome'],
  setting_changed: ['setting_key'],
  search_performed: ['status', 'result_count'],
  agent_cli_action: [
    'agent_type',
    'target',
    'install_method',
    'action',
    'outcome',
    'failure_reason',
    'duration_ms',
  ],
  room_created: [
    'server_kind',
    'bridge_platform',
    'agent_count',
    'has_instructions',
    'outcome',
    'failure_reason',
    'source',
  ],
  room_deleted: ['server_kind', 'outcome'],
  room_agents_added: ['agent_count', 'direction', 'outcome', 'failure_reason'],
  server_sign_in: ['auth_method', 'server_kind', 'outcome', 'failure_reason'],
  server_sign_out: ['server_kind'],
  host_setup_step: ['step_kind', 'agent_type', 'action', 'outcome'],
  host_onboarded: ['outcome', 'picked_from_ssh_config'],
  host_removed: ['outcome'],
  managed_server_action: ['action', 'target', 'outcome', 'failure_reason', 'docker_available'],
  view_opened: ['view_id'],
  command_executed: ['command_id', 'invoked_by'],
  deeplink_opened: ['resolved', 'cold_start'],
  add_server_step: ['step', 'choice', 'first_run'],
  onboarding_page: ['page', 'path'],
  buddy_step: ['action', 'provider'],
  home_action: ['action', 'chip'],
  renderer_crashed: [],
  telemetry_consent_changed: ['source', 'install_kind'],
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
