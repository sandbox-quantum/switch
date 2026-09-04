/**
 * Shared types for the Switch-server integration: the gateways Switch Console can
 * connect to, the auth methods they offer, and the read-only summaries of the
 * remote agents/rooms Switch Console queries live from the active server.
 *
 * The gateway is OIDC-*mediated* (it is the OIDC client; Switch Console just rides
 * the flow and captures the resulting session cookie), and authenticates every
 * management call with the `switch_auth` cookie. Switch Console stores that cookie
 * in the encrypted secrets store, never in plain settings.
 */

import type { RemoteDirInspection } from '@shared/core/remote-hosts/remote-dir';

/**
 * Origin (protocol + host + port, lowercased) of a URL, or null if unparseable.
 * Agents are matched to servers by origin rather than full URL: an agent's
 * `SWITCH_API_ENDPOINT` and a server's API URL share a host but may differ in
 * path, so comparing origins is the robust match.
 */
export function urlOrigin(url: string): string | null {
  try {
    return new URL(url.trim()).origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Whether two Switch API endpoints name the same server. This is how an agent's
 * on-disk `SWITCH_API_ENDPOINT` is matched to a registered server, so the main
 * process and the renderer must agree on it: the renderer decides which discovered
 * agents are offered as importable, and the main process enforces it.
 *
 * Origins are compared when both parse — path and trailing slash are not
 * differences. Unparseable input falls back to a trimmed string comparison rather
 * than reporting a match it cannot vouch for.
 */
export function sameApiEndpoint(a: string, b: string): boolean {
  const originA = urlOrigin(a);
  const originB = urlOrigin(b);
  if (originA && originB) return originA === originB;
  return a.trim().replace(/\/+$/, '') === b.trim().replace(/\/+$/, '');
}

/** A registered Switch server. Non-secret connection metadata only. */
export type SwitchServer = {
  id: string;
  name: string;
  /** Origin of the gateway deployment, e.g. `https://switch-gateway.example.com`.
   * The management API lives under `${gatewayUrl}/gateway`. */
  gatewayUrl: string;
  /** Origin of the Switch core (agent bridge) API, e.g.
   * `https://switch-api.example.com` — what an agent's `SWITCH_API_ENDPOINT`
   * points at, and what an onboarded agent is matched to its server by. */
  apiUrl: string;
  /** True when Switch Console runs this server itself (docker compose). Managed
   * servers are driven by the lifecycle controls, not the add/edit-server UI. */
  managed: boolean;
  /** Where a managed server runs: `local` (this computer's Docker) or `remote`
   * (a host's Docker over SSH). Null for external (non-managed) servers. Legacy
   * managed rows with no kind are read as `local`. */
  managementKind: 'local' | 'remote' | null;
  /** SSH alias of the host a remote-managed server runs on. Null for local and
   * external servers. */
  sshHost: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AddServerParams = {
  name: string;
  gatewayUrl: string;
  apiUrl: string;
};

/** Identifies which managed server to upsert/look up: the single local stack,
 * or the remote stack on a given SSH host. */
export type ManagedServerRef = { kind: 'local' } | { kind: 'remote'; sshHost: string };

export type UpdateServerParams = {
  id: string;
  name: string;
  gatewayUrl: string;
  apiUrl: string;
};

/** Rename a server (display name only). Works for managed and external servers;
 * URLs and managed metadata are untouched. */
export type RenameServerParams = {
  id: string;
  name: string;
};

/**
 * What happened to one agent when a server's API URL was cascaded to its
 * members. `updated` — the agent's `SWITCH_API_ENDPOINT` was rewritten.
 * `not-provisioned` — the agent has no Switch credentials on disk yet, so there
 * was nothing to update (skipped, not an error). `failed` — the rewrite threw
 * (e.g. an unreachable SSH host); `error` carries why.
 */
export type AgentApiUrlPropagationOutcome = 'updated' | 'not-provisioned' | 'failed';

/** Per-agent result of a server-API-URL cascade. */
export type AgentApiUrlPropagation = {
  agentId: string;
  agentName: string;
  /** Where the agent's config lives: a local dir vs. an SSH host. */
  location: 'local' | 'remote';
  outcome: AgentApiUrlPropagationOutcome;
  /** Present only when `outcome === 'failed'`. */
  error?: string;
};

/** Summary of cascading a server's API-URL edit to its member agents. */
export type ServerApiUrlPropagation = {
  /** True when the API URL actually changed, so propagation ran. When false the
   * `agents` list is empty (the edit was name/gateway-only). */
  apiUrlChanged: boolean;
  agents: AgentApiUrlPropagation[];
};

/** Result of editing a server: the saved record plus the agent-config cascade. */
export type UpdateServerResult = {
  server: SwitchServer;
  propagation: ServerApiUrlPropagation;
};

/** Which login methods a gateway offers — read unauthenticated from
 * `GET /gateway/auth/config` so the UI shows the right options. */
export type SwitchAuthConfig = {
  passwordLoginEnabled: boolean;
  oidcEnabled: boolean;
  /** Button label for the OIDC provider (e.g. "Okta"), or null. */
  oidcProviderLabel: string | null;
};

/** What a switch-core says about itself to an authenticated client (CHOO-1865).
 *
 * `version` is null when the server cannot read its own version. Null means
 * unknown and must be rendered as such, never as current. */
export type SwitchServerDeclaration = {
  version: string | null;
  contracts: Record<string, { speaks: number; accepts: number }>;
};

/** The authenticated user, as returned by `GET /gateway/auth/me`. */
export type SwitchUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  /**
   * What the server declared on this session response.
   *
   * Null when the server predates version disclosure — which is the honest
   * reading, not a defect. This is the only version signal available for a
   * server Switch Console does not manage: `readDeployedVersion` needs host access
   * to read an image tag, so a BYO server used to report nothing at all, ever.
   */
  server: SwitchServerDeclaration | null;
};

/** Connection status for a server: whether Switch Console holds a valid session. */
export type ServerConnectionStatus = {
  serverId: string;
  connected: boolean;
  /** The signed-in user when connected; null otherwise. */
  user: SwitchUser | null;
};

export type PasswordLoginParams = {
  serverId: string;
  email: string;
  password: string;
};

/** Read-only summary of a remote agent (mirrors the gateway `AgentSummary`). */
export type RemoteAgentSummary = {
  id: string;
  name: string;
  description: string;
  connectorType: string;
  /** Switch user id of the agent's owner, or null for an agent registered
   * before ownership was tracked. The id rather than the name is what an
   * "is this mine" check can be made against. */
  ownerId: string | null;
  ownerName: string | null;
  knownAgentType: string | null;
  /** Who may address the agent, or null when it is open to everyone. On the
   * summary as well as the detail, so "which of these agents answers only its
   * owner" is one list read rather than a read per agent. Null also for a
   * server older than the field, which reads the same as open. */
  addressingPolicy: AddressingPolicy | null;
  /** Absolute URL of the agent's own icon, or null when it has none. Null is
   * the ordinary state rather than an error: the display layer draws a
   * name-derived avatar instead, so the fallback can change without every
   * agent needing rewriting. */
  iconUrl: string | null;
  createdAt: string;
};

/**
 * What came of giving this user's icon-less agents their generated avatar
 * (CHOO-2171).
 *
 * Reported rather than logged because the app cannot tell the difference on
 * screen: it draws a name-derived bot for any agent with no stored icon, so a
 * server that rejected every write still looks right here while the chat
 * platforms show the lettered avatar.
 */
export type AgentIconBackfill =
  | { kind: 'written'; written: number }
  /** The server has no agent-icon endpoint — it predates the feature. */
  | { kind: 'unsupported' }
  | { kind: 'partial'; written: number; failed: number };

/** Read-only summary of a remote room (mirrors the gateway `RoomSummary`). */
export type RemoteRoomSummary = {
  id: string;
  name: string;
  description: string;
  channelType: string | null;
  agentCount: number;
  bridgeDisplayName: string | null;
  /** Bridge platform type (`slack`, `mattermost`, …) when bridged, else null.
   * Stable key (unlike the user-chosen display name); drives the room icon. */
  bridgeType: string | null;
  /** Native deeplink that opens this room's channel in the messaging app's
   * desktop client (slack://…, mattermost://…), or null when not bridged / the
   * bridge is down / the platform has no scheme. Built server-side. */
  externalChannelUrl: string | null;
  /** Switch user who owns the room — whoever created it. Null for rooms created
   * before ownership was tracked, or auto-created by an inbound bridge channel.
   * Rooms the signed-in user owns stay listed in the sidebar even with no live
   * session, so a room you just made never vanishes on you. */
  ownerId: string | null;
  archived: boolean;
  createdAt: string;
};

/**
 * One room read on its own (mirrors the gateway `RoomDetail`), for the room's
 * own configuration page.
 *
 * The room list cannot answer this: it carries neither the instructions nor who
 * is in the room, only how many agents there are. Both are read one room at a
 * time because both are what that room's page is for.
 */
export type RemoteRoomDetail = RemoteRoomSummary & {
  /** Room-specific system prompt shown to agents on connect; null when unset. */
  instructions: string | null;
  /** Switch agent ids in the room — every install's agents, not just this one's. */
  agentIds: string[];
  /** Display names of the people in the room, via the messaging app it is
   * bridged to. Empty for an unbridged room, which has no people in it. */
  connectedUserNames: string[];
};

/** The room fields Switch Console can change. Anything omitted is left alone;
 * an empty string clears the field rather than leaving it. */
export type UpdateRoomParams = {
  serverId: string;
  roomId: string;
  description?: string;
  instructions?: string;
};

/**
 * A room a specific agent belongs to, with that agent's presence there (mirrors
 * the gateway `AgentRoomMembership`). Drives the "connect to room" picker at
 * session start and the room-focused sidebar grouping.
 */
export type RemoteAgentRoom = {
  roomId: string;
  roomName: string;
  archived: boolean;
  /** live / no_session / disconnected / awaiting_manual_poll. */
  status: string;
  /** The room-scoped role the agent currently holds, or null. */
  roomRole: string | null;
};

/** A room group on a server (mirrors the gateway `RoomGroupDetail`). Used to
 * scope an addressing rule by room group. */
export type RemoteRoomGroup = {
  id: string;
  name: string;
};

/**
 * A collaboration bridge configured on a server (mirrors the gateway
 * `BridgeDetail`). Every room Switch Console creates is bridged to one of these, so
 * the humans it is being created for can actually reach it.
 */
export type RemoteBridge = {
  id: string;
  /** Platform key (`slack`, `mattermost`, …) — drives the bridge icon. */
  type: string;
  displayName: string;
  /** Only `active` bridges can back a new room. */
  status: string;
  /** The bridge used when a room is created without naming one. */
  isDefault: boolean;
  /**
   * Link that opens this bridge's workspace in its messaging app, from the
   * gateway's live adapter. Null when the bridge is not running, the platform
   * offers no such link, or the server predates the field — so treat its
   * absence as "no action to offer", not as an error.
   */
  homeUrl: string | null;
  /**
   * Whether the platform this connection runs on can create a channel at all
   * (e.g. false for Telegram — the Bot API has no such call). Fixed per
   * platform; not something an operator can change. Defaults to true for a
   * server predating the field, matching how every bridge behaved before the
   * capability existed.
   */
  channelCreationSupported: boolean;
  /**
   * Whether this connection may actually be used to create a channel —
   * `channelCreationSupported` ANDed with the operator's own switch for this
   * connection. This is the one callers creating a room should read;
   * `channelCreationSupported` exists only to explain *why* when this is
   * false (a platform ceiling vs. an operator's choice).
   */
  canCreateChannels: boolean;
  /**
   * Whether this platform has a user directory Switch can search. False where
   * the only people it can name are the ones who have spoken to it, which is
   * why the "which account is you" step is not offered while connecting one:
   * on a connection nobody has used yet the answer is always nobody. Defaults
   * to true for a server predating the field — every platform Switch bridged
   * before Telegram had one.
   */
  directorySearchSupported: boolean;
};

/**
 * How to sign in to a managed deployment's bundled Mattermost directly — in a
 * browser or the desktop Mattermost client, on the machine running it
 * (CHOO-1787). The stack publishes onto loopback, so nothing off that machine
 * can reach the URL.
 *
 * `unavailable` carries the reason in words a user can act on, and is the only
 * alternative to real values: the credentials are per-deployment and generated,
 * so a plausible-looking default would be worse than saying nothing.
 */
export type BundledChatSignIn =
  | {
      kind: 'available';
      /** Origin to paste into the Mattermost client's "server URL" field. */
      url: string;
      username: string;
      password: string;
    }
  | { kind: 'unavailable'; reason: string };

/**
 * One credential field a bridge type needs, projected from the JSON Schema the
 * gateway derives from the adapter's Pydantic config model.
 *
 * The schema is the server's to define, not Switch Console's: a Slack bridge needs
 * different fields from a Discord one, and a switch-core release can add a
 * field without an app release. So the attach form is generated from this
 * rather than hand-written per platform.
 */
export type BridgeConfigField = {
  key: string;
  label: string;
  description: string | null;
  required: boolean;
  /** Render masked and keep out of logs. Set from the schema's
   * `format: "password"` hint, falling back to a name heuristic. */
  secret: boolean;
  /** The schema's primitive type, so the form renders a control that matches
   * it. A boolean posted as the string the server cannot parse is rejected
   * outright, so this is not only about how it looks. */
  kind: 'string' | 'boolean';
  /** The schema's default, so an untouched field posts what the platform
   * expects rather than nothing. */
  default: string | boolean | null;
};

/** A bridge type registered on a server, with the fields needed to attach one
 * (mirrors the gateway `BridgeTypeInfo`, with its raw JSON Schema flattened
 * into an ordered field list). */
export type RemoteBridgeType = {
  /** Platform key (`slack`, `mattermost`, …). */
  key: string;
  fields: BridgeConfigField[];
  /** Whether this platform can create channels at all — read from the
   * adapter class, so it is answerable before any connection of this type
   * exists, which is exactly when the attach form needs it. */
  channelCreationSupported: boolean;
  /** Whether this platform's user directory can be searched — read from the
   * adapter class, so the connect flow can decide whether to offer the
   * link-your-account step for a connection that does not exist yet. */
  directorySearchSupported: boolean;
};

/**
 * Parameters for attaching a collaboration bridge to a server from inside
 * Switch Console (CHOO-1784).
 *
 * `connectionConfig` carries platform credentials — a Slack bot token, a
 * Discord bot token, a Mattermost admin password. It is main-process-only: it
 * goes straight to the server over HTTPS and is never persisted by Switch Console,
 * never logged, and never sent back to the renderer.
 */
export type CreateBridgeParams = {
  serverId: string;
  bridgeType: string;
  displayName: string;
  connectionConfig: Record<string, string | boolean>;
  /** Make this the bridge new rooms land on when none is named. */
  setAsDefault: boolean;
  /** Whether this connection may create channels on the platform. The
   * gateway defaults this to true when omitted, but Switch Console always
   * states it explicitly, forced off for a platform that cannot create
   * channels at all — registering `true` there returns 400. */
  channelCreationEnabled: boolean;
};

/**
 * Outcome of attaching a bridge. As with room creation, recoverable gateway
 * failures become variants the modal can say out loud rather than a raw throw.
 *
 * `forbidden` is its own case because it is not a fault the user can fix by
 * editing the form: registering a bridge is admin-only, so a non-admin needs
 * telling that rather than a validation error.
 */
export type CreateBridgeResult =
  | { kind: 'created'; bridge: RemoteBridge }
  | { kind: 'unauthenticated' }
  | { kind: 'forbidden' }
  /** The server rejected the credentials or the config shape (400/422). */
  | { kind: 'invalid'; message: string }
  | { kind: 'error'; message: string };

/**
 * Parameters for editing an existing bridge's operator-controlled switches
 * (`PATCH /collaborations/{id}`). Only `channelCreationEnabled` is wired up
 * today; leave a field unset to leave it unchanged, matching the gateway's
 * own partial-update contract.
 */
export type UpdateBridgeParams = {
  serverId: string;
  bridgeId: string;
  channelCreationEnabled?: boolean;
};

/** Outcome of editing a bridge. Mirrors {@link CreateBridgeResult}'s recoverable
 * cases: editing is admin-only like registering, so a non-admin gets the same
 * `forbidden` rather than a validation error. */
export type UpdateBridgeResult =
  | { kind: 'updated'; bridge: RemoteBridge }
  | { kind: 'unauthenticated' }
  | { kind: 'forbidden' }
  | { kind: 'invalid'; message: string }
  | { kind: 'error'; message: string };

/** Parameters for disconnecting a bridge from a server
 * (`DELETE /collaborations/{id}`). */
export type DeleteBridgeParams = {
  serverId: string;
  bridgeId: string;
};

/**
 * Outcome of disconnecting a bridge.
 *
 * `deleted` means the bridge *and every Switch room that lived on it* are gone
 * — the gateway deletes the rooms first — so this is not the inverse of
 * attaching one, and a caller must have said so before asking.
 *
 * `not-found` is its own case rather than a success: a bridge that is already
 * absent is usually another operator's deletion, and reporting it as done hides
 * a mistyped id just as effectively.
 */
export type DeleteBridgeResult =
  | { kind: 'deleted' }
  | { kind: 'unauthenticated' }
  | { kind: 'forbidden' }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string };

/** A bridged (external) human identity on a server. The `users` dimension of an
 * addressing policy keys off these ids. */
export type RemoteExternalUser = {
  id: string;
  username: string;
};

/**
 * A Switch user who says a platform account is theirs (mirrors the gateway
 * `IdentityClaimant`).
 */
export type IdentityClaimant = {
  userId: string;
  userName: string;
};

/**
 * Someone found in a messaging platform's own user directory (mirrors the
 * gateway `DirectoryUserSummary`).
 *
 * Switch only records a person once they have spoken, so a freshly connected
 * workspace has nobody to pick from. The directory is the platform's, which is
 * what lets a user claim their account before ever posting.
 */
export type BridgeDirectoryUser = {
  /** The platform's own id (a Slack `U…`, a Mattermost user id). */
  externalUserId: string;
  username: string;
  displayName: string;
  email: string | null;
  /** The `ExternalUser` row id when Switch has already seen this person, else
   * null. Present rows are reused on claim rather than duplicated. */
  knownExternalUserId: string | null;
  /** Everyone who has claimed this account. Claiming is not exclusive, so this
   * is information about who else is recognised on the account rather than a
   * reason to stop someone claiming it too. */
  claimedBy: IdentityClaimant[];
};

/**
 * Outcome of searching a bridge's user directory.
 *
 * `unsupported` is its own case rather than an empty list: a platform with no
 * searchable directory (Telegram) answers 501, and the only way forward is to
 * post a message so Switch learns the account exists. Showing "no matches"
 * there would send the user searching harder for something that can never
 * appear.
 */
export type BridgeDirectorySearchResult =
  /**
   * `note` is set when the platform has no searchable directory and the server
   * answered from the accounts it has already seen instead. The results are
   * real but narrower — someone who has never spoken is not among them — so it
   * is shown alongside them, never in their place.
   */
  | { kind: 'results'; users: BridgeDirectoryUser[]; note: string | null }
  /** Only reachable against a switch-core predating the fallback above, which
   * refused the search outright rather than narrowing it. */
  | { kind: 'unsupported'; message: string }
  | { kind: 'bridge-unavailable'; message: string }
  | { kind: 'unauthenticated' }
  | { kind: 'error'; message: string };

/** Claim a platform identity for the signed-in Switch user (CHOO-2137). */
export type ClaimIdentityParams = {
  serverId: string;
  bridgeId: string;
  /** The platform's own id, not an `ExternalUser` row id — the row may not
   * exist yet, and the server creates it on demand. */
  externalUserId: string;
  username: string;
};

/**
 * Outcome of claiming an identity. `bridge-unavailable` is the one failure a
 * user can act on: an account Switch has never seen has to be provisioned on
 * the platform's side, which a stopped bridge cannot do.
 */
export type ClaimIdentityResult =
  | { kind: 'claimed'; identity: LinkedIdentity }
  | { kind: 'bridge-unavailable'; message: string }
  | { kind: 'unauthenticated' }
  | { kind: 'error'; message: string };

/**
 * One messaging account the signed-in user has claimed (mirrors the gateway
 * `LinkedIdentity`).
 *
 * An agent whose addressing policy names its owner is only reachable by that
 * owner over a bridge that appears in this list — which is why the app reads it
 * to warn before a policy seals an agent off from everybody.
 */
export type LinkedIdentity = {
  /** The `ExternalUser` row id; what unclaiming addresses. */
  id: string;
  bridgeId: string;
  bridgeDisplayName: string;
  bridgeType: string;
  externalUserId: string;
  externalUsername: string;
};

/**
 * Scoped agent-addressing permissions (CHOO-1585). Each dimension is "*" (any)
 * or an explicit id list ([] = none). A policy with no rules — or a null policy
 * on the agent — means it is open to anyone. `users` ids are ExternalUser ids;
 * `agents` ids are agent ids. Mirrors the gateway/core `AddressingPolicy`.
 */
export type AddressingDimension = '*' | string[];

export type AddressingRule = {
  rooms: AddressingDimension;
  room_groups: AddressingDimension;
  users: AddressingDimension;
  agents: AddressingDimension;
  /**
   * Admit the agent's owner, resolved when the message arrives rather than
   * frozen into the `users` list (CHOO-2137). It survives connecting a new
   * workspace, recreating a bridge, or the agent changing hands — but it can
   * only recognise an owner who has claimed their messaging account, so a rule
   * that names the owner on a platform where they have not admits nobody.
   *
   * Optional because a policy written before the field exists carries no
   * `owner` key; absent reads as false, as it does server-side.
   */
  owner?: boolean;
  /**
   * Admit any agent owned by the same person, resolved on arrival like
   * {@link owner} (CHOO-2137). The owner's manager agent handing work to their
   * worker is the owner acting through a program; naming each one in `agents`
   * would go stale the next time they register one.
   *
   * Optional for the same reason as `owner`: absent reads as false.
   */
  owner_agents?: boolean;
};

export type AddressingPolicy = {
  rules: AddressingRule[];
};

/**
 * Result of checking whether an agent exists on a chosen server.
 * `found` — the server owns the agent. `not-found` — it doesn't (wrong server
 * or unregistered agent id). `unauthenticated` — not signed in to that server.
 */
export type AgentVerifyResult = 'found' | 'not-found' | 'unauthenticated';

/** Suggested defaults for a new Claude Code agent, derived in the main process
 * from the directory and the OS user (so the name disambiguates which person's
 * Claude Code this is — mirrors the `configure` skill's naming guidance). */
export type AgentDefaults = {
  name: string;
  description: string;
};

/**
 * Whether this Claude Code install can drive the development-channels flag.
 * `anthropic` (Anthropic login / API key) → `channels_enabled = true` →
 * session_addressable. `third-party` (Vertex AI / Bedrock / other) →
 * `channels_enabled = false` → session_passive. There is no safe default; the
 * user must choose, since the wrong value corrupts the agent's room behaviour.
 */
export type AgentProviderKind = 'anthropic' | 'third-party';

/**
 * Parameters to register a brand-new Claude Code agent on a server and write
 * its credentials into the directory's `.claude/settings.local.json` — the
 * desktop equivalent of running the switch-connector `configure` skill.
 */
export type ProvisionAgentParams = {
  serverId: string;
  /** The agent's working directory; the settings file is written here and used
   * as `repo_dir` so an offline-session command can `cd` into it. */
  dir: string;
  name: string;
  description: string;
  providerKind: AgentProviderKind;
  /** Register with the `auto_session` connection model: Switch Console watches the
   * agent's rooms and auto-spawns a session on notification. Defaults to off. */
  autoSession?: boolean;
};

/**
 * Parameters to register a brand-new Claude Code agent on a server and write its
 * credentials into a REMOTE working directory's `.claude/settings.local.json`
 * over SSH — the remote-host equivalent of {@link ProvisionAgentParams}. There
 * is no local directory: the agent's config lives entirely on the host.
 */
export type ProvisionRemoteAgentParams = {
  serverId: string;
  /** SSH alias of the onboarded host the agent runs on. */
  sshHost: string;
  /** The agent's working directory on the host; the settings file is written
   * here and used as `repo_dir`. */
  remoteRepoDir: string;
  name: string;
  description: string;
  providerKind: AgentProviderKind;
  /** Register with the `auto_session` connection model. Defaults to off. */
  autoSession?: boolean;
};

/**
 * Outcome of provisioning a new agent. `created` carries the new Switch agent
 * id; the other variants map a recoverable gateway failure to a specific
 * message the modal can act on (re-login, rename) rather than a raw throw. The
 * minted API token is written to disk by the main process and never returned.
 */
/**
 * The recoverable ways minting an identity on the gateway can fail. Separate
 * from {@link ProvisionAgentResult} because provisioning can also fail for
 * reasons the gateway never sees — the working directory, so far — and a caller
 * handling a registration result should not have to consider those.
 */
export type RegisterIdentityFailure =
  | { kind: 'unauthenticated' }
  | { kind: 'name-conflict' }
  | { kind: 'invalid-name'; message: string }
  | { kind: 'error'; message: string };

export type ProvisionAgentResult =
  | { kind: 'created'; agentId: string }
  /** The working directory already holds credentials for this name belonging to
   * the Switch deployment at `endpoint` — another install's agent. Refused
   * before minting, so nothing was created. */
  | { kind: 'credentials-conflict'; endpoint: string }
  /** The remote working directory is unusable — a file, or its parent is
   * missing too. Produced by the add-agent path, which checks before minting
   * (CHOO-1416). */
  | { kind: 'directory-missing'; sshHost: string; inspection: RemoteDirInspection }
  | RegisterIdentityFailure;

/**
 * Parameters for creating a room on a server from inside Switch Console
 * (CHOO-1875) — the minimal set that gets a user to a working room. The wider
 * gateway surface (roles, groups, visibility, references, existing-channel
 * binding) stays in the operator web app.
 *
 * A bridge is mandatory: a room nobody can reach from a messaging app is not a
 * useful room, so there is no internal-only path here.
 */
export type CreateRoomParams = {
  serverId: string;
  name: string;
  description: string;
  /** Room-specific system prompt shown to agents on connect. Optional. */
  instructions?: string;
  bridgeId: string;
  /** Switch agent ids to add as members. May be empty — a bridged room is
   * valid with no agents, and members can be invited later. */
  agentIds: string[];
};

/**
 * Outcome of creating a room. `created` carries the new room; every other
 * variant maps a recoverable gateway failure onto something the modal can say
 * out loud, rather than a raw throw or a silent no-op.
 *
 * `bridge-unavailable` is its own case because it is the one failure a user can
 * act on directly (start the bridge, or pick another) — the gateway reports an
 * unknown bridge id and a stopped bridge identically, as a 400.
 */
export type CreateRoomResult =
  | { kind: 'created'; room: RemoteRoomSummary }
  | { kind: 'unauthenticated' }
  | { kind: 'bridge-unavailable'; message: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'error'; message: string };

/**
 * A role defined in a room — an assumable instruction bundle (mirrors the
 * gateway `RoomRoleDetail`). Offered when starting a session connected to a
 * room so the agent can assume a specific role on connect.
 */
export type RemoteRoomRole = {
  name: string;
  instructions: string;
  /** Exclusive roles can be held by at most one agent at a time. */
  exclusive: boolean;
  /** Display names of agents currently holding the role (empty if free). */
  heldBy: string[];
};
