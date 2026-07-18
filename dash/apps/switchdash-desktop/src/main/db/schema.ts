import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { versionedJsonColumn } from '@main/db/versioned-column';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { sessionConfig } from '@shared/core/sessions/session-config';
import type { TerminalShellId } from '@shared/core/terminals/terminal-settings';

// ---------------------------------------------------------------------------
// Data model (switchdash rework — diverges from upstream; see
// agents/architecture/data-model.md for the full map):
//
//   locations — a working directory on a host (this machine or an SSH host)
//     └─ agents    — a Switch agent identity (one provider each; many per
//          │         location)
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
 * A Switch server: a gateway switchdash can connect to. switchdash is
 * multi-server — many gateways (a local dev one, a deployed pilot one) can be
 * registered, and the UI works against one "active" server at a time (the
 * active id is tracked in `kv` under `activeSwitchServerId`). The session JWT
 * minted by the gateway is NOT stored here — it lives in the encrypted secrets
 * store keyed by server id — so this table holds only non-secret connection
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
 * A Switch agent: an agent identity bound to a single provider, living at a
 * location. Many agents may share a location (e.g. a Claude Code and a Codex
 * agent in the same repo). `switchAgentId` / `apiEndpoint` are populated when
 * the location dir is configured as a Switch agent (detected from
 * `.claude/settings.local.json`); they are null for a plain local agent.
 *
 * `serverId` binds the agent to the one registered Switch server it belongs to.
 * It is resolved by matching the detected `apiEndpoint` against the registered
 * servers' origins. It is nullable: an agent whose server is not (or no longer)
 * registered is shown as "unlinked" rather than guessed, and removing a server
 * sets its agents' `serverId` to null instead of deleting them.
 */
export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    locationId: text('location_id')
      .notNull()
      .references(() => locations.id),
    name: text('name').notNull(),
    providerId: text('provider_id').$type<AgentProviderId>().notNull(),
    switchAgentId: text('switch_agent_id'),
    apiEndpoint: text('api_endpoint'),
    serverId: text('server_id').references(() => switchServers.id, { onDelete: 'set null' }),
    status: text('status'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    locationIdIdx: index('idx_agents_location_id').on(table.locationId),
    serverIdIdx: index('idx_agents_server_id').on(table.serverId),
  })
);

/**
 * A session: one instantiation/run of an agent. This is the unit shown under an
 * agent in the sidebar. A session is 1:1 with its terminal (the PTY the agent
 * CLI runs in), so the terminal's `shellId` lives here rather than in a separate
 * table.
 */
/**
 * An onboarded remote SSH host. switchdash stores no credentials — a host is
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

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    config: versionedJsonColumn(sessionConfig)('config'),
    shellId: text('shell_id').$type<TerminalShellId>().notNull().default('system'),
    status: text('status'),
    agentSessionId: text('agent_session_id'),
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
export type RemoteHostRow = typeof remoteHosts.$inferSelect;
export type RemoteHostInsert = typeof remoteHosts.$inferInsert;
