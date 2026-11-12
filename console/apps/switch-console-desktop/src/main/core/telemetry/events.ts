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

/**
 * Why a chat action failed, as an enumerated code. The gateway's own refusal
 * codes (`NOT_A_MEMBER`, `REQUEST_REUSED`, …) are not passed through: they are
 * the server's vocabulary and grow with it, and a refusal is one bucket here —
 * the server reports its own side.
 */
export type TelemetryChatFailure =
  | 'none'
  | 'unauthenticated'
  /** The server answered and said no: a 4xx, coded or not. */
  | 'refused'
  | 'network'
  | 'server_error'
  | 'error';

/** A chat as it was asked for: one agent and its person, or a group. */
export type TelemetryChatKind = 'direct' | 'group';

/** Whom a message named: nobody, an agent, a person, or both. Never which. */
export type TelemetryChatMentions = 'none' | 'agent' | 'person' | 'both';

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

/**
 * The kinds of server this install can hold. Named once, used by five events.
 * `cloud` is Switch Cloud, the server this build offers by name; `external` is
 * any other server someone registered by address.
 */
export type TelemetryServerKind = 'local' | 'remote_managed' | 'external' | 'cloud';

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
 * How a session of an agent on this computer's agent controller started, as
 * its session host told Switch (`host/session-start.ts`): a person in Console,
 * the agent being addressed in a room, or the automation API. `unknown` is a
 * launcher that did not say.
 */
export type TelemetryManagedSessionStartSource = 'user' | 'room' | 'automation' | 'unknown';

/**
 * The steps from installing the app to an agent doing work, each reported
 * once for the life of an install (`./activation`).
 */
export type TelemetryActivationMilestone = 'server_ready' | 'agent_ready' | 'first_agent_session';

/**
 * Which way the install went at Meet switch-buddy: `buddy` started the buddy,
 * `manual` skipped it. `unknown` until one of the two happens, which is after
 * a server is ready, so `server_ready` normally carries it.
 */
export type TelemetryActivationPath = 'buddy' | 'manual' | 'unknown';

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
export type TelemetryEventMap = {
  /** The app started, and which kind of launch it was. */
  app_launched: {
    install_kind: TelemetryInstallKind;
  };
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
    /**
     * `external` is a server the user registered by URL: Switch Console does not
     * run it. `cloud` is Switch Cloud, registered from its own button.
     */
    server_kind: TelemetryServerKind;
    outcome: TelemetryOutcome;
    failure_reason: TelemetryServerAddFailure;
  };
  /**
   * The app checked for an update. `trigger` separates a check someone asked for
   * from the hourly one, because only the first says anything about intent.
   */
  update_checked: {
    trigger: TelemetryUpdateTrigger;
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
   * An install was started — not finished.
   *
   * Deliberately named for what it can actually observe. A successful install
   * quits the app, so there is no moment afterwards in which to report one; what
   * this counts is the point the update was handed to the installer. Whether it
   * worked is answered by `update_installed` on the next launch. A launch that
   * comes back on the old version reports this event again, as a failure.
   */
  update_install_started: {
    outcome: TelemetryOutcome;
  };
  /**
   * The first launch on a new version after an update: the end of the update.
   * The new version is the event's own app version, which every event carries.
   *
   * `from_version` is the version the previous launch ran; `unknown` for an
   * install from before launches were recorded, or a stored value that is not a
   * version. `trigger` is `restart_button` when the previous run handed the update
   * to the installer from Restart to update, and `other` when the version changed
   * without that: installed when the app quit, or by hand.
   */
  update_installed: {
    from_version: TelemetryAppVersion | 'unknown';
    trigger: 'restart_button' | 'other';
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
    trigger: TelemetryAgentRemoveTrigger;
    outcome: TelemetryOutcome;
    failure_reason: TelemetryAgentRemoveFailure;
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
   * A session of an agent on the agent controller this app runs on this
   * computer started, and its Switch server took the report. These agents
   * have no session of their own in the app, so `session_started` never sees
   * them; a session on another machine's controller is not reported at all.
   */
  managed_session_started: {
    agent_type: TelemetryAgentType;
    start_source: TelemetryManagedSessionStartSource;
  };
  /**
   * A step towards an agent doing work, the first time this install reaches
   * it. Derived from the events that mark each one, never sent twice, and only
   * by an install that began on a version that reports them (`./activation`).
   */
  activation_milestone: {
    milestone: TelemetryActivationMilestone;
    path: TelemetryActivationPath;
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
   * A Switch Console chat was made: a 1-1 with an agent, or a group. `kind`,
   * `agent_count` and `person_count` are what was asked for — the counts of
   * agents and of other people invited, never who. `on_messaging_app` is a chat
   * opened in a messaging app connection rather than in Switch. Finishing a
   * create an earlier attempt already made is not reported again.
   */
  chat_created: {
    server_kind: TelemetryServerKind;
    kind: TelemetryChatKind;
    agent_count: number;
    person_count: number;
    on_messaging_app: boolean;
    outcome: TelemetryOutcome;
    failure_reason: TelemetryChatFailure;
  };
  /**
   * A message was sent in a chat. Nothing of the message: whether it carried
   * files, whether it was a thread reply, and whether it named an agent or a
   * person — never which.
   */
  chat_message_sent: {
    server_kind: TelemetryServerKind;
    has_attachment: boolean;
    in_thread: boolean;
    mentions: TelemetryChatMentions;
    outcome: TelemetryOutcome;
    failure_reason: TelemetryChatFailure;
  };
  /** A person or an agent was added to a chat, or taken out of one. */
  chat_member_changed: {
    server_kind: TelemetryServerKind;
    change: 'added' | 'removed';
    member_kind: 'person' | 'agent';
    outcome: TelemetryOutcome;
    failure_reason: TelemetryChatFailure;
  };
  /**
   * Stop, Reset, Compact or Retry was sent to an agent in a chat. Written out
   * rather than taken from `ChatControlCommand`, so the disclosure test reads
   * the values; a command added there fails to compile at the call site.
   */
  chat_control_sent: {
    server_kind: TelemetryServerKind;
    command: 'interrupt' | 'reset' | 'compact' | 'retry';
    outcome: TelemetryOutcome;
    failure_reason: TelemetryChatFailure;
  };
  /** An agent's approval request was answered in a chat. Never the answer. */
  chat_approval_answered: {
    server_kind: TelemetryServerKind;
    outcome: TelemetryOutcome;
    failure_reason: TelemetryChatFailure;
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
  onboarding_page: RendererTelemetryEvents['onboarding_page'];
  buddy_step: RendererTelemetryEvents['buddy_step'];
  buddy_message_sent: RendererTelemetryEvents['buddy_message_sent'];
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
    /**
     * This launch's kind, so a new install agreeing at first run is one filter;
     * `unknown` when the launch could not be recorded.
     */
    install_kind: TelemetryInstallKind | 'unknown';
  };
};

export type TelemetryEventName = keyof TelemetryEventMap;

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
  app_launched: ['install_kind'],
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
  server_added: ['server_kind', 'outcome', 'failure_reason'],
  update_checked: ['trigger', 'result'],
  update_download_started: [],
  update_downloaded: ['outcome'],
  update_install_started: ['outcome'],
  update_installed: ['from_version', 'trigger'],
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
  room_agents_added: ['agent_count', 'direction'],
  chat_created: [
    'server_kind',
    'kind',
    'agent_count',
    'person_count',
    'on_messaging_app',
    'outcome',
    'failure_reason',
  ],
  chat_message_sent: [
    'server_kind',
    'has_attachment',
    'in_thread',
    'mentions',
    'outcome',
    'failure_reason',
  ],
  chat_member_changed: ['server_kind', 'change', 'member_kind', 'outcome', 'failure_reason'],
  chat_control_sent: ['server_kind', 'command', 'outcome', 'failure_reason'],
  chat_approval_answered: ['server_kind', 'outcome', 'failure_reason'],
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
  add_server_step: ['step', 'choice', 'first_run'],
  onboarding_page: ['page', 'path'],
  buddy_step: ['action', 'provider'],
  buddy_message_sent: ['nth'],
  renderer_crashed: [],
  telemetry_consent_changed: ['source', 'install_kind'],
  session_attached: ['agent_type', 'outcome'],
  managed_session_started: ['agent_type', 'start_source'],
  activation_milestone: ['milestone', 'path'],
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
