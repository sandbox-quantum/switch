import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { versionedJsonColumn } from '@main/db/versioned-column';
import { agentProviderConfig } from '@shared/core/agents/agent-provider-config';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { sessionConfig } from '@shared/core/sessions/session-config';
import type { WorkspaceRole } from '@shared/core/workspaces/workspaces';

// ---------------------------------------------------------------------------
// Data model (Switch Console rework — diverges from upstream; see
// agents/architecture/data-model.md for the full map):
//
//   switch_servers — a registered Switch gateway
//     └─ workspaces — what the window is scoped to; one active at a time
//
//   locations — a working directory on a host (this machine or an SSH host)
//     └─ agents    — a Switch agent identity (one provider each; many per
//          │         location; belongs to one workspace)
//          └─ sessions  — an instantiation/run of an agent (was "conversation";
//          │              one session == one terminal, folded in)
//               └─ messages
//
// Dropped from upstream: the worktree-era `sessions` grouping, the `terminals`
// table (folded 1:1 into a session), and the location/workspace split (a
// `locations` identity table plus a runtime workspace keyed off it) — both
// collapsed into `locations` (CHOO-1426). Every session runs in its agent's
// location dir.
// ---------------------------------------------------------------------------

/**
 * A Location: where an agent's sessions run — a working directory on a host.
 * `sshHost` is the `~/.ssh/config` Host alias for remote locations and the
 * empty string for the local machine (a sentinel rather than NULL so the
 * (ssh_host, dir) unique index actually enforces one row per place — SQLite
 * treats NULLs as distinct in unique indexes). Multiple agents may share one
 * location.
 */
export const locations = sqliteTable(
  'locations',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    sshHost: text('ssh_host').notNull().default(''),
    dir: text('dir').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    hostDirIdx: uniqueIndex('idx_locations_host_dir').on(table.sshHost, table.dir),
  })
);

export const locationSettings = sqliteTable('location_settings', {
  locationId: text('location_id')
    .primaryKey()
    .references(() => locations.id, { onDelete: 'cascade' }),
  baseSettingsJson: text('base_settings_json').notNull().default('{}'),
  shareableSettingsJson: text('shareable_settings_json').notNull().default('{}'),
  legacyConfigMigratedAt: text('legacy_config_migrated_at'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const appSettings = sqliteTable(
  'app_settings',
  {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
    updatedAt: integer('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    keyIdx: uniqueIndex('idx_app_settings_key').on(table.key),
  })
);

/**
 * A Switch server: a gateway Switch Console can connect to. Switch Console is
 * multi-server — many gateways (a local dev one, a deployed pilot one) can be
 * registered. What the window is scoped to is a workspace on one of them, not
 * the server itself, so the active selection names a workspace (`kv`,
 * `activeWorkspaceId`) and the server is read from it. The session JWT minted
 * by the gateway is NOT stored here — it lives in the encrypted secrets store
 * keyed by server id — so this table holds only non-secret connection
 * metadata.
 */
export const switchServers = sqliteTable(
  'switch_servers',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** Origin of the gateway deployment; the management API is at
     * `${gatewayUrl}/gateway`. */
    gatewayUrl: text('gateway_url').notNull(),
    /**
     * Origin of the Switch *core* (agent bridge) API — what an agent's
     * `SWITCH_API_ENDPOINT` points at, and what an onboarded agent is matched to
     * its server by. May differ from `gatewayUrl` (e.g. `switch-api.*` vs
     * `switch-gateway.*`).
     */
    apiUrl: text('api_url').notNull(),
    /** True when Switch Console provisions and runs this server itself via
     * docker compose. Managed servers get lifecycle controls (start/stop/reset)
     * and are not user-editable connection records. */
    managed: integer('managed', { mode: 'boolean' }).notNull().default(false),
    /** Where a managed server runs: `local` (this computer) or `remote` (an SSH
     * host). Null for external servers; a legacy managed row with a null kind is
     * read as `local`. */
    managementKind: text('management_kind'),
    /** SSH alias of the host a remote-managed server runs on; null otherwise. */
    sshHost: text('ssh_host'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    gatewayUrlIdx: uniqueIndex('idx_switch_servers_gateway_url').on(table.gatewayUrl),
  })
);

/**
 * A workspace: the unit everything in the window is scoped to. A server hosts
 * one or more of them, and exactly one workspace is active at a time (tracked
 * in `kv` under `activeWorkspaceId`). Switching workspace swaps the whole
 * window — agents, rooms, sidebar — the way switching server used to.
 *
 * `tenantId` is the workspace's id on the gateway. It is null only until the
 * gateway has been asked: a workspace is created locally the moment a server is
 * registered, because the app has to be usable before the answer arrives, and
 * the upgrade to workspaces created one per already-registered server the same
 * way. Every deployed Switch server has tenancy — the backend migration that
 * introduced it puts every existing user in a tenant — so a tenant-less row is
 * a workspace that has not reconciled yet, not a server without tenants.
 *
 * Reconcile therefore has to *match* that row to a tenant rather than insert
 * the real workspace beside it: the row's id is what every agent points at, and
 * the (server, tenant) unique index cannot catch a duplicate here because
 * SQLite treats NULLs as distinct.
 *
 * `slug` is the gateway's handle for the workspace; null alongside a null
 * `tenantId`.
 */
export const workspaces = sqliteTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => switchServers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** The workspace's id on the gateway; null when the server has no tenancy. */
    tenantId: text('tenant_id'),
    /** The gateway's slug for the workspace; null when it has no tenancy. */
    slug: text('slug'),
    /**
     * The caller's role in the workspace as the gateway last reported it
     * (`owner` / `admin` / `member`). Null for a tenant-less workspace, where
     * the notion does not apply.
     */
    role: text('role').$type<WorkspaceRole>(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    serverIdIdx: index('idx_workspaces_server_id').on(table.serverId),
    serverTenantIdx: uniqueIndex('idx_workspaces_server_tenant').on(table.serverId, table.tenantId),
    // A server has at most one unreconciled row. The index above cannot say so,
    // because SQLite treats NULLs as distinct, so two registrations racing on
    // the same server would each insert a placeholder and reconcile would only
    // ever repair the first one it found.
    serverPlaceholderIdx: uniqueIndex('idx_workspaces_server_placeholder')
      .on(table.serverId)
      .where(sql`tenant_id IS NULL`),
  })
);

/**
 * A Switch agent: an agent identity bound to a single provider, living at a
 * location. Many agents may share a location (e.g. a Claude Code and a Codex
 * agent in the same repo). `switchAgentId` / `apiEndpoint` are populated when
 * the location dir is configured as a Switch agent (detected from
 * `.claude/settings.local.json`); they are null for a plain local agent.
 *
 * `workspaceId` binds the agent to the one workspace it belongs to, chosen and
 * verified at onboarding rather than inferred. It is nullable: an agent whose
 * workspace is gone is shown as "unlinked" rather than guessed, and removing a
 * server sets its workspaces' agents to null instead of deleting them.
 */
export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    locationId: text('location_id')
      .notNull()
      .references(() => locations.id),
    // The agent's single identity. For a provider that launches as a named
    // definition (Claude Code → `--agent <name>`) this is that name; how the
    // name is turned into a launch is the provider's business, not a column.
    // There is no separate definition name (CHOO-1440).
    name: text('name').notNull(),
    providerId: text('provider_id').$type<AgentProviderId>().notNull(),
    switchAgentId: text('switch_agent_id'),
    apiEndpoint: text('api_endpoint'),
    workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    status: text('status'),
    // When set, Switch Console launches this agent's CLI with its auto-approve /
    // "bypass permissions" flag (e.g. `--dangerously-skip-permissions`).
    // Defaults false for local agents; onboarding seeds it true for remote
    // agents (see onboard-agent). Editable per agent in location settings.
    autoApprove: integer('auto_approve', { mode: 'boolean' }).notNull().default(false),
    // The display name of the agent's owner on the Switch server, set when the
    // agent was loaded from another install rather than created here.
    ownerName: text('owner_name'),
    // Per-agent, provider-specific launch config (Codex model / effort /
    // instructions folded into the agent's Codex profile). Null when unset.
    providerConfig: versionedJsonColumn(agentProviderConfig)('provider_config'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    locationIdIdx: index('idx_agents_location_id').on(table.locationId),
    workspaceIdIdx: index('idx_agents_workspace_id').on(table.workspaceId),
  })
);

/**
 * A session: one instantiation/run of an agent. This is the unit shown under an
 * agent in the sidebar. Each session is driven by its SDK provider adapter.
 */
/**
 * An onboarded remote SSH host. Switch Console stores no credentials — a host is
 * identified by its `~/.ssh/config` Host alias (`sshHost`), and auth resolves
 * from the user's SSH config/agent exactly as remote agents do (CHOO-1059). This
 * table only tracks *which* aliases the user has onboarded (so they can be listed
 * and managed on the remote-hosts page) plus a friendly display name.
 */
export const remoteHosts = sqliteTable('remote_hosts', {
  /** The `~/.ssh/config` Host alias. Natural primary key — one row per alias. */
  sshHost: text('ssh_host').primaryKey(),
  name: text('name').notNull(),
  createdAt: text('created_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

/**
 * Persisted reachability of a remote SSH host (CHOO-1682). Keyed by the same
 * `~/.ssh/config` alias as `remote_hosts` and `locations.ssh_host`, but kept in
 * its own table because a location can name a host that was never onboarded —
 * reachability must be tracked for any alias we actually talk to, not only the
 * ones on the remote-hosts page.
 *
 * Persisting it means a restart does not forget that a host was down: the app
 * boots into the known-bad state and schedules a probe, instead of every
 * host-dependent path racing to rediscover the failure at once.
 */
export const remoteHostReachability = sqliteTable('remote_host_reachability', {
  sshHost: text('ssh_host').primaryKey(),
  /** One of HostReachabilityStatus — 'unknown' | 'reachable' | 'unreachable' | 'suspended'. */
  status: text('status').notNull().default('unknown'),
  lastError: text('last_error'),
  lastCheckedAt: text('last_checked_at'),
  lastReachableAt: text('last_reachable_at'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

/**
 * A remote host's setup run (CHOO-1809). Onboarding is a sequence — check and
 * install each prerequisite in turn — and a sequence that cannot be resumed is
 * a sequence that strands the host the first time step 3 fails. Persisting the
 * plan is what makes "continue where you left off" possible across an app
 * restart, and what lets the host list say *why* a host is not ready without
 * re-probing it.
 *
 * `steps` is the JSON-serialised HostSetupStep[]. It is stored as one document
 * rather than a child table because it is only ever read and written whole, and
 * its shape is owned by the shared setup model rather than by SQL. It is
 * validated on read — a row we cannot parse raises instead of silently
 * degrading to "no plan", which would read as "nothing left to do".
 */
export const remoteHostSetupPlans = sqliteTable('remote_host_setup_plans', {
  /** The `~/.ssh/config` Host alias. One plan per host. */
  sshHost: text('ssh_host').primaryKey(),
  /**
   * One of HostSetupPlanStatus — 'idle' | 'complete'. Rows written before the
   * automated run was removed may still say 'running' or 'halted'; the plan
   * store maps those on read.
   */
  status: text('status').notNull().default('idle'),
  /** JSON-encoded HostSetupStep[]. */
  steps: text('steps').notNull(),
  /** The step in flight, or the one that halted the run. */
  currentStepId: text('current_step_id'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    config: versionedJsonColumn(sessionConfig)('config'),
    status: text('status'),
    agentStatus: text('agent_status'),
    agentStatusSeen: integer('agent_status_seen').default(1),
    isInitialSession: integer('is_initial_session', { mode: 'boolean' }),
    isPinned: integer('is_pinned').notNull().default(0), // boolean, 0=false, 1=true
    archivedAt: text('archived_at'), // null = active, timestamp = archived
    lastInteractedAt: text('last_interacted_at'),
    statusChangedAt: text('status_changed_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    agentIdIdx: index('idx_sessions_agent_id').on(table.agentId),
  })
);

/**
 * The Switch room a session is attending, durable across restarts so a resumed
 * session re-polls its room without waiting for the agent to call
 * `connect_to_room` again.
 *
 * Keyed by session and cascaded from it: a session (or the agent above it)
 * going away takes its room connection with it. That cascade is the point of
 * the table — the previous storage, a single JSON blob in `app_settings`,
 * referenced nothing and so outlived the sessions it described, resurrecting
 * pollers for agents whose Switch server had been destroyed.
 *
 * `switchAgentId` is the identity on the Switch side (an agent's
 * `SWITCH_AGENT_ID`), not `agents.id` — it is reported by the connecting agent
 * and carried for display, so it is deliberately not a foreign key.
 */
export const sessionRoomConnections = sqliteTable('session_room_connections', {
  sessionId: text('session_id')
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  roomId: text('room_id').notNull(),
  roomName: text('room_name'),
  switchAgentId: text('switch_agent_id'),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    sender: text('sender').notNull(),
    timestamp: text('timestamp')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    metadata: text('metadata'),
  },
  (table) => ({
    sessionIdIdx: index('idx_messages_session_id').on(table.sessionId),
    timestampIdx: index('idx_messages_timestamp').on(table.timestamp),
  })
);

export const kv = sqliteTable(
  'kv',
  {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
    updatedAt: integer('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    keyIdx: uniqueIndex('idx_kv_key').on(table.key),
  })
);

export const appSecrets = sqliteTable(
  'app_secrets',
  {
    key: text('key').primaryKey(),
    secret: text('secret').notNull(),
  },
  (table) => ({
    keyIdx: uniqueIndex('idx_app_secrets_key').on(table.key),
  })
);

export type LocationRow = typeof locations.$inferSelect;
export type LocationInsert = typeof locations.$inferInsert;
export type LocationSettingsRow = typeof locationSettings.$inferSelect;
export type LocationSettingsInsert = typeof locationSettings.$inferInsert;
export type AgentRow = typeof agents.$inferSelect;
export type AgentInsert = typeof agents.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type SessionInsert = typeof sessions.$inferInsert;
export type MessageRow = typeof messages.$inferSelect;
export type KvRow = typeof kv.$inferSelect;
export type KvInsert = typeof kv.$inferInsert;
export type AppSecretRow = typeof appSecrets.$inferSelect;
export type AppSecretInsert = typeof appSecrets.$inferInsert;
export type SwitchServerRow = typeof switchServers.$inferSelect;
export type SwitchServerInsert = typeof switchServers.$inferInsert;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type WorkspaceInsert = typeof workspaces.$inferInsert;
export type RemoteHostRow = typeof remoteHosts.$inferSelect;
export type RemoteHostInsert = typeof remoteHosts.$inferInsert;
export type RemoteHostReachabilityRow = typeof remoteHostReachability.$inferSelect;
export type RemoteHostReachabilityInsert = typeof remoteHostReachability.$inferInsert;
export type RemoteHostSetupPlanRow = typeof remoteHostSetupPlans.$inferSelect;
export type RemoteHostSetupPlanInsert = typeof remoteHostSetupPlans.$inferInsert;
