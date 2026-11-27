/**
 * Core Switch server types shared between Console and the gateway: server
 * connections, remote agents/rooms, auth config, and agent provisioning.
 *
 * This is a minimal subset extracted from Console's switch-servers module,
 * containing only what the shared agent management UI needs.
 */

export type SwitchServer = {
  id: string;
  name: string;
  url: string;
  dashboardUrl: string | null;
  managed: boolean;
  managementKind: 'local' | 'remote' | null;
  sshHost: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RemoteAgentSummary = {
  id: string;
  name: string;
  description: string;
  connectorType: string;
  ownerId: string | null;
  ownerName: string | null;
  knownAgentType: string | null;
  knownAgentOptions: Record<string, unknown> | null;
  addressingPolicy: AddressingPolicy | null;
  midTurnDelivery?: 'steer' | 'queue';
  iconUrl: string | null;
  displayName: string | null;
  createdAt: string;
};

export type AddressingDimension = '*' | string[];

export type AddressingRule = {
  rooms: AddressingDimension;
  room_groups: AddressingDimension;
  users: AddressingDimension;
  agents: AddressingDimension;
  owner?: boolean;
  owner_agents?: boolean;
  platform?: boolean;
};

export type AddressingPolicy = {
  rules: AddressingRule[];
};

export type SwitchUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  hasPassword?: boolean;
  server: SwitchServerDeclaration | null;
};

export type SwitchServerDeclaration = {
  version: string | null;
  contracts: Record<string, { speaks: number; accepts: number }>;
};

export type CloudMachine = {
  machine_id: string;
  state:
    | 'queued'
    | 'provisioning'
    | 'ready'
    | 'stopping'
    | 'stopped'
    | 'error'
    | 'retained'
    | 'deleting'
    | 'deleted';
  desired_state: 'running' | 'stopped' | 'retained' | 'deleted';
  stop_reason: 'idle' | 'owner' | null;
  stopped_by_admin: boolean;
  sleeping: boolean;
  revision: number;
  instance_type: string | null;
  error: string | null;
  error_code: string | null;
  retain_until: string | null;
  heartbeat_at: string | null;
  disk: { total_bytes: number; available_bytes: number } | null;
  memory: { total_bytes: number; available_bytes: number } | null;
  agents: string[];
  controller_id: string | null;
};

export type RemoteBridge = {
  id: string;
  type: string;
  displayName: string;
  status: string;
  isDefault: boolean;
  preconfigured: boolean | null;
  homeUrl: string | null;
  channelCreationSupported: boolean;
  canCreateChannels: boolean;
  directorySearchSupported: boolean;
  directorySearchHint: string;
  attention: string | null;
  teamPlacementSupported: boolean;
  channelIdsRefused: string | null;
  privateChannels: boolean | null;
  privateChannelNeedsLinkedAccount: boolean;
  publicChannelAddsCreator: boolean;
  receivesWebhooks: boolean;
  webhookUrl: string | null;
  commands: Record<string, string>;
};

export type RoomAccess = 'public' | 'private';

export type NewRoomChannel =
  | { kind: 'new'; private: boolean }
  | { kind: 'existing'; externalChannelId: string };

export type RemoteRoomSummary = {
  id: string;
  name: string;
  description: string;
  instructions: string | null;
  bridgeId: string | null;
  bridgeType: string | null;
  externalChannelId: string | null;
  channelType: string | null;
  createdAt: string;
};

export type CreateRoomResult =
  | { kind: 'created'; room: RemoteRoomSummary }
  | { kind: 'unauthenticated' }
  | { kind: 'bridge-unavailable'; message?: string }
  | { kind: 'invalid-request'; message?: string }
  | { kind: 'error'; message?: string };

/**
 * One credential field a messaging app needs, read from the JSON Schema the
 * server derives from the platform's config model, so a field a server adds
 * appears without an app release.
 */
export type BridgeConfigField = {
  key: string;
  label: string;
  description: string | null;
  required: boolean;
  /** Typed masked and kept out of logs. */
  secret: boolean;
  /** A boolean posts a real boolean: the server rejects an empty string as one. */
  kind: 'string' | 'boolean';
  /** What an untouched field posts. */
  default: string | boolean | null;
};

/** A messaging app a server can connect, with what connecting one asks for. */
export type MessagingAppType = {
  key: string;
  fields: BridgeConfigField[];
  channelCreationSupported: boolean;
  /** Whether its people can be searched, which linking an account needs. */
  directorySearchSupported: boolean;
};

/** A platform whose chats are connected one at a time with a link or code (the Switch Telegram app). */
export type ClaimablePlatform = {
  platform: string;
  /** The workspace already has this platform's connection. */
  connected: boolean;
  canAddChat: boolean;
};

/** What the server's own messaging apps offer the signed-in person. */
export type MessagingAppOffers = {
  /** Platforms added with a consent screen. Empty for anyone but an admin. */
  installable: string[];
  claimable: ClaimablePlatform[];
};

/** A one-time link and code that connect a chat, and the bot's handle to search for. */
export type ChatClaim = {
  url: string;
  code: string;
  botHandle: string;
};

/** A Slack app of your own: Slack's create-app page, filled in for this server. */
export type SlackOwnAppSetup = {
  createUrl: string;
  /** The manifest as JSON, for pasting by hand; null from a server that does not send it. */
  manifestJson: string | null;
};

/** Both tokens of a Slack app work, and the workspace they belong to. */
export type SlackTokensChecked = { workspaceId: string; workspaceName: string; botName: string };
