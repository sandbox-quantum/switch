/**
 * Shared types for the Switch-server integration: the gateways switchdash can
 * connect to, the auth methods they offer, and the read-only summaries of the
 * remote agents/rooms switchdash queries live from the active server.
 *
 * The gateway is OIDC-*mediated* (it is the OIDC client; switchdash just rides
 * the flow and captures the resulting session cookie), and authenticates every
 * management call with the `switch_auth` cookie. switchdash stores that cookie
 * in the encrypted secrets store, never in plain settings.
 */

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
  /** True when switchdash runs this server itself (docker compose). Managed
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
   * server switchdash does not manage: `readDeployedVersion` needs host access
   * to read an image tag, so a BYO server used to report nothing at all, ever.
   */
  server: SwitchServerDeclaration | null;
};

/** Connection status for a server: whether switchdash holds a valid session. */
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
  ownerName: string | null;
  knownAgentType: string | null;
  createdAt: string;
};

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
 * `BridgeDetail`). Every room switchdash creates is bridged to one of these, so
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
 * The schema is the server's to define, not switchdash's: a Slack bridge needs
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
};

/** A bridge type registered on a server, with the fields needed to attach one
 * (mirrors the gateway `BridgeTypeInfo`, with its raw JSON Schema flattened
 * into an ordered field list). */
export type RemoteBridgeType = {
  /** Platform key (`slack`, `mattermost`, …). */
  key: string;
  fields: BridgeConfigField[];
};

/**
 * Parameters for attaching a collaboration bridge to a server from inside
 * switchdash (CHOO-1784).
 *
 * `connectionConfig` carries platform credentials — a Slack bot token, a
 * Discord bot token, a Mattermost admin password. It is main-process-only: it
 * goes straight to the server over HTTPS and is never persisted by switchdash,
 * never logged, and never sent back to the renderer.
 */
export type CreateBridgeParams = {
  serverId: string;
  bridgeType: string;
  displayName: string;
  connectionConfig: Record<string, string>;
  /** Make this the bridge new rooms land on when none is named. */
  setAsDefault: boolean;
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

/** A bridged (external) human identity on a server. The `users` dimension of an
 * addressing policy keys off these ids. */
export type RemoteExternalUser = {
  id: string;
  username: string;
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
  /** Bridge handle to @-mention in offline-session notices; omit to skip. */
  notifyUser?: string;
  /** Register with the `auto_session` connection model: switchdash watches the
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
  /** Bridge handle to @-mention in offline-session notices; omit to skip. */
  notifyUser?: string;
  /** Register with the `auto_session` connection model. Defaults to off. */
  autoSession?: boolean;
};

/**
 * Outcome of provisioning a new agent. `created` carries the new Switch agent
 * id; the other variants map a recoverable gateway failure to a specific
 * message the modal can act on (re-login, rename) rather than a raw throw. The
 * minted API token is written to disk by the main process and never returned.
 */
export type ProvisionAgentResult =
  | { kind: 'created'; agentId: string }
  | { kind: 'unauthenticated' }
  | { kind: 'name-conflict' }
  | { kind: 'invalid-name'; message: string }
  | { kind: 'error'; message: string };

/**
 * Parameters for creating a room on a server from inside switchdash
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
