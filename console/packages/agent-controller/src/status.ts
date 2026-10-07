import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, statfs } from 'node:fs/promises';
import { arch, freemem, platform, release, totalmem } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import type { ProviderReadiness } from '@switch-console/agent-providers';
import { pluginRegistry } from '@switch-console/plugins/agents';
import { errorMessage, type Logger } from './log';
import { emptyObservation, type AgentObservation, type AgentRuntime } from './runtime';
import {
  type AgentActivity,
  type AgentAssignment,
  type AgentStatus,
  type Assignment,
  type Platform,
  type ProcessState,
  PROTOCOL_VERSION,
  type Provider,
  PROVIDERS,
  type ProviderStatus,
  type ReasonCode,
  type StatusReport,
} from './schemas';
import type { AgentRow, ControllerStore } from './store';

export const PROVIDER_TTL_MS = 10 * 60 * 1000;
const VERSION_TIMEOUT_MS = 10_000;
const DETAIL_LIMIT = 1000;
/** A launch this recent with nothing alive yet is still starting, not crashed. */
export const LAUNCH_GRACE_MS = 15_000;

export function contractPlatform(): Platform {
  const os = platform();
  return {
    os: os === 'darwin' ? 'macos' : os === 'win32' ? 'windows' : os,
    arch: arch(),
    os_version: release(),
  };
}

export type LocatedProvider = { path: string; version: string | null };

/** Finds a provider's CLI on this machine. */
export interface ProviderLocator {
  /** Where a signed-in provider's login comes from: the machine's own, or sealed by Switch. */
  readonly authSource: 'local' | 'sealed';
  locate(provider: Provider): Promise<LocatedProvider | null>;
}

/**
 * Looks each provider's CLI up on `PATH` under the names its plugin declares,
 * as Console's dependency detection does, and asks it for its version.
 */
export class PathProviderLocator implements ProviderLocator {
  readonly authSource = 'local';

  constructor(private readonly path: string | undefined) {}

  async locate(provider: Provider): Promise<LocatedProvider | null> {
    const plugin = pluginRegistry.get(provider);
    if (!plugin) throw new Error(`No provider plugin is registered for '${provider}'.`);
    const dependency = plugin.capabilities.hostDependency;
    const directories = (this.path ?? '').split(delimiter).filter(Boolean);
    for (const name of dependency.binaryNames)
      for (const directory of directories) {
        const candidate = join(directory, name);
        try {
          await access(candidate, constants.X_OK);
        } catch {
          continue;
        }
        return {
          path: candidate,
          version: dependency.skipVersionProbe
            ? null
            : await readVersion(candidate, dependency.versionArgs ?? ['--version']),
        };
      }
    return null;
  }
}

/**
 * Each provider's CLI at the path a cloud machine's image installed it, whose
 * logins Switch seals for the machine.
 */
export class FixedProviderLocator implements ProviderLocator {
  readonly authSource = 'sealed';

  constructor(private readonly paths: Partial<Record<Provider, string>>) {}

  async locate(provider: Provider): Promise<LocatedProvider | null> {
    const path = this.paths[provider];
    if (path === undefined) return null;
    try {
      await access(path, constants.X_OK);
    } catch {
      return null;
    }
    const plugin = pluginRegistry.get(provider);
    if (!plugin) throw new Error(`No provider plugin is registered for '${provider}'.`);
    const dependency = plugin.capabilities.hostDependency;
    return {
      path,
      version: dependency.skipVersionProbe
        ? null
        : await readVersion(path, dependency.versionArgs ?? ['--version']),
    };
  }
}

async function readVersion(binary: string, args: string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await promisify(execFile)(binary, args, {
      timeout: VERSION_TIMEOUT_MS,
    });
    return `${stdout}\n${stderr}`.match(/\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/)?.[0] ?? null;
  } catch {
    return null;
  }
}

export function providerStatusFrom(
  provider: Provider,
  located: LocatedProvider | null,
  readiness: ProviderReadiness | null,
  checkedAt: string,
  authSource: 'local' | 'sealed'
): ProviderStatus {
  if (!located)
    return {
      provider,
      installed: false,
      version: null,
      auth: 'unknown',
      auth_source: null,
      checked_at: checkedAt,
      reason: 'provider_not_installed',
    };
  const base = { provider, installed: true, version: located.version, checked_at: checkedAt };
  if (!readiness) return { ...base, auth: 'unknown', auth_source: null, reason: 'internal' };
  switch (readiness.status) {
    case 'authenticated':
      return { ...base, auth: 'ok', auth_source: authSource };
    case 'unauthenticated':
    case 'unconfigured':
      return { ...base, auth: 'missing', auth_source: null, reason: 'provider_login_missing' };
    case 'unknown':
      return { ...base, auth: 'unknown', auth_source: null };
  }
}

/**
 * Each provider's installation and login, checked at most every ten minutes
 * unless a recheck is forced. A check that finds something different calls
 * `onChange`, so the next status report carries it.
 */
export class ProviderStatuses {
  private readonly entries = new Map<
    Provider,
    { status: ProviderStatus; path: string | null; at: number }
  >();
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly deps: {
      locator: ProviderLocator;
      runtime: Pick<AgentRuntime, 'probe'>;
      probeCwd: string;
      now: () => number;
      log: Logger;
      onChange: () => void;
    }
  ) {}

  /** Checks one provider now. */
  async check(provider: Provider): Promise<ProviderStatus> {
    const at = this.deps.now();
    const located = await this.deps.locator.locate(provider);
    let readiness: ProviderReadiness | null = null;
    if (located)
      try {
        readiness = await this.deps.runtime.probe(provider, located.path, this.deps.probeCwd);
      } catch (error) {
        this.deps.log.warn('Could not check a provider’s login', {
          provider,
          error: errorMessage(error),
        });
      }
    const status = providerStatusFrom(
      provider,
      located,
      readiness,
      new Date(at).toISOString(),
      this.deps.locator.authSource
    );
    const previous = this.entries.get(provider);
    this.entries.set(provider, { status, path: located?.path ?? null, at });
    if (!previous || fingerprintProvider(previous.status) !== fingerprintProvider(status))
      this.deps.onChange();
    return status;
  }

  /** Checks every provider whose last check is older than the TTL, all at once. */
  async refreshStale(): Promise<void> {
    this.refreshing ??= Promise.all(
      PROVIDERS.filter((provider) => {
        const entry = this.entries.get(provider);
        return !entry || this.deps.now() - entry.at >= PROVIDER_TTL_MS;
      }).map((provider) => this.check(provider))
    )
      .then(() => {})
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  /** What is known now; providers not checked yet are left out rather than guessed. */
  snapshot(): ProviderStatus[] {
    return PROVIDERS.flatMap((provider) => {
      const entry = this.entries.get(provider);
      return entry ? [entry.status] : [];
    });
  }

  /** The provider's CLI as last located, checking first when it never was or the check is stale. */
  async binaryPath(provider: Provider): Promise<string | null> {
    const entry = this.entries.get(provider);
    if (entry && this.deps.now() - entry.at < PROVIDER_TTL_MS && entry.path) return entry.path;
    const located = await this.deps.locator.locate(provider);
    return located?.path ?? null;
  }
}

function fingerprintProvider(status: ProviderStatus): string {
  return JSON.stringify([status.installed, status.version, status.auth, status.reason ?? null]);
}

/** An agent host that stopped because its token was refused (by the relay, now). */
export function isCredentialFailure(message: string): boolean {
  return /rejected the agent credentials|credentials belong to a different agent/i.test(message);
}

function truncate(text: string): string {
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT - 1)}…` : text;
}

type Mapped = {
  process: ProcessState;
  attached: boolean;
  reason?: ReasonCode;
  detail?: string;
  /** When the agent host itself says the state began. */
  since?: string;
};

/** One agent's process state in the contract's terms, from what the controller recorded and sees. */
export function mapAgentProcess(input: {
  assignment: AgentAssignment;
  row: AgentRow | null;
  observation: AgentObservation;
  /** The agent's events flow on the controller stream and its agent host is taking them. */
  relayAttached: boolean;
  nowMs: number;
}): Mapped {
  const { assignment, row, observation } = input;
  if (row?.failure && row.failure.revision === assignment.revision)
    return {
      process: 'failed',
      attached: false,
      reason: row.failure.reason,
      detail: truncate(row.failure.detail),
    };
  const desiredStopped = assignment.desired_state === 'stopped';
  const health = observation.health?.current ? observation.health : null;
  if (observation.alive) {
    if (desiredStopped || observation.flags?.enabled === false)
      return { process: 'stopping', attached: false };
    if (!health) return { process: 'starting', attached: false };
    switch (health.state) {
      case 'connected':
        return { process: 'running', attached: input.relayAttached, since: health.since };
      case 'connecting':
        return { process: 'starting', attached: false, since: health.since };
      case 'disconnected':
        return {
          process: 'running',
          attached: false,
          since: health.since,
          detail: truncate(
            `Reconnecting to the controller's relay${health.detail ? `: ${health.detail}` : ''}`
          ),
        };
      default:
        return { process: 'stopping', attached: false };
    }
  }
  if (!desiredStopped && (row?.appliedRevision ?? null) === null)
    return { process: 'pending', attached: false };
  if (observation.takenOver)
    return {
      process: 'failed',
      attached: false,
      reason: 'taken_over',
      detail: truncate(
        `Another client took this agent's room connection (${observation.takenOver.reason}); restart the agent to take it back.`
      ),
    };
  if (observation.failure)
    return {
      process: 'failed',
      attached: false,
      reason: isCredentialFailure(observation.failure) ? 'invalid_credential' : 'internal',
      detail: truncate(observation.failure),
    };
  if (desiredStopped) return { process: 'stopped', attached: false };
  if ((row?.appliedRevision ?? -1) < assignment.revision)
    return { process: 'pending', attached: false };
  if (row && input.nowMs - Date.parse(row.changedAt) < LAUNCH_GRACE_MS)
    return { process: 'starting', attached: false };
  return {
    process: 'crashed',
    attached: false,
    reason: 'internal',
    detail: 'The agent host is not running and recorded no failure.',
  };
}

/**
 * Builds status reports: the machine, the providers as last checked, and every
 * assigned agent as its agent host's files describe it. `since` is kept across
 * reports so it marks when an agent entered its current state.
 */
export class StatusCollector {
  private readonly previous = new Map<string, { process: ProcessState; since: string }>();

  constructor(
    private readonly deps: {
      store: ControllerStore;
      runtime: AgentRuntime;
      providers: ProviderStatuses;
      /** Whether the relay has the agent attached; see `mapAgentProcess`. */
      attached: (agentId: string) => boolean;
      dataDir: string;
      /** Where agents with no directory of their own work, reported so the server can name it. */
      workspacesDir: string;
      version: string;
      now: () => number;
      log: Logger;
    }
  ) {}

  async collect(
    assignment: Assignment | null
  ): Promise<Omit<StatusReport, 'seq'> & { activity: AgentActivity[] }> {
    const nowMs = this.deps.now();
    const now = new Date(nowMs).toISOString();
    const agents: AgentStatus[] = [];
    const activity: AgentActivity[] = [];
    const seen = new Set<string>();
    for (const entry of assignment?.agents ?? []) {
      seen.add(entry.agent_id);
      const row = this.deps.store.agent(entry.agent_id);
      let observation: AgentObservation;
      try {
        observation = await this.deps.runtime.observe(entry.agent_id);
      } catch (error) {
        this.deps.log.warn('Could not observe agent state; reporting as failed', {
          agentId: entry.agent_id,
          error: errorMessage(error),
        });
        observation = {
          ...emptyObservation(),
          failure: errorMessage(error),
        };
      }
      const mapped = mapAgentProcess({
        assignment: entry,
        row,
        observation,
        relayAttached: this.deps.attached(entry.agent_id),
        nowMs,
      });
      const before = this.previous.get(entry.agent_id);
      const since =
        before && before.process === mapped.process ? before.since : (mapped.since ?? now);
      this.previous.set(entry.agent_id, { process: mapped.process, since });
      const health = observation.alive && observation.health?.current ? observation.health : null;
      const ids = health ? Object.keys(health.placements).sort() : [];
      agents.push({
        agent_id: entry.agent_id,
        applied_revision: row?.appliedRevision ?? null,
        process: mapped.process,
        attached: mapped.attached,
        sessions: { active: ids.length, ids },
        restarts_10m:
          this.deps.store.restartsSince(entry.agent_id, nowMs - 10 * 60 * 1000) +
          (observation.unit?.restarts10m ?? 0),
        oom_kills: observation.unit?.oomKills ?? 0,
        directory: observation.configured?.cwd ?? null,
        since,
        ...(mapped.reason ? { reason: mapped.reason } : {}),
        ...(mapped.detail ? { detail: mapped.detail } : {}),
      });
      // An agent host that does not say whether it is busy is taken to be.
      activity.push({
        agent_id: entry.agent_id,
        busy: observation.alive ? (observation.activity?.busy ?? true) : false,
        sessions: ids.length,
        last_activity_at: observation.activity?.lastActivityAt ?? null,
      });
    }
    for (const agentId of this.previous.keys())
      if (!seen.has(agentId)) this.previous.delete(agentId);
    const disk = await statfs(this.deps.dataDir);
    return {
      observed_at: now,
      controller: {
        version: this.deps.version,
        protocol: PROTOCOL_VERSION,
        assignment_revision: assignment?.revision ?? 0,
      },
      machine: {
        platform: contractPlatform(),
        disk_free_bytes: disk.bavail * disk.bsize,
        disk_total_bytes: disk.blocks * disk.bsize,
        mem_free_bytes: freemem(),
        mem_total_bytes: totalmem(),
        sessions_running: agents.reduce((total, agent) => total + agent.sessions.active, 0),
        // v1 enforces no session limit; 0 says so rather than inventing one.
        sessions_max: 0,
        workspaces_dir: this.deps.workspacesDir,
      },
      providers: this.deps.providers.snapshot(),
      tools: [],
      agents,
      activity,
    };
  }
}

/**
 * What a report is compared on to decide whether something changed: the
 * states, not the counters and clocks that move on their own.
 */
export function statusFingerprint(report: Omit<StatusReport, 'seq'>): string {
  return JSON.stringify({
    revision: report.controller.assignment_revision,
    providers: report.providers.map((p) => [p.provider, p.installed, p.version, p.auth, p.reason]),
    agents: report.agents.map((a) => [
      a.agent_id,
      a.applied_revision,
      a.process,
      a.attached,
      a.reason,
      a.detail,
      a.sessions.ids,
      a.directory,
    ]),
  });
}
