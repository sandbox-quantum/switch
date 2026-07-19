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
  /** True when switchdash runs this server itself (local-server mode). Managed
   * servers are driven by the lifecycle controls, not the add/edit-server UI. */
  managed: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AddServerParams = {
  name: string;
  gatewayUrl: string;
  apiUrl: string;
};

export type UpdateServerParams = {
  id: string;
  name: string;
  gatewayUrl: string;
  apiUrl: string;
};

/** Which login methods a gateway offers — read unauthenticated from
 * `GET /gateway/auth/config` so the UI shows the right options. */
export type SwitchAuthConfig = {
  passwordLoginEnabled: boolean;
  oidcEnabled: boolean;
  /** Button label for the OIDC provider (e.g. "Okta"), or null. */
  oidcProviderLabel: string | null;
};

/** The authenticated user, as returned by `GET /gateway/auth/me`. */
export type SwitchUser = {
  id: string;
  name: string;
  email: string;
  role: string;
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
