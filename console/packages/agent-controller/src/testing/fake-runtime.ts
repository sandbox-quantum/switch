import type {
  OpenAgentStream,
  ProviderReadiness,
  SharedHostConfig,
} from '@switch-console/agent-providers';
import { ReasonedError } from '../errors';
import {
  type AgentObservation,
  type AgentRuntime,
  emptyObservation,
  type LaunchOptions,
  type RelayCredentials,
} from '../runtime';
import type { Provider } from '../schemas';
import type { LocatedProvider, ProviderLocator } from '../status';

export type RuntimeCall =
  | { kind: 'launch'; agentId: string; template: SharedHostConfig; options: LaunchOptions }
  | { kind: 'stop'; agentId: string; wait: boolean }
  | { kind: 'writeCredentials'; agentId: string; endpoint: string; token: string }
  | { kind: 'deleteCredentials'; agentId: string };

/** An `AgentRuntime` that keeps every agent in memory and records what it was asked to do. */
export class FakeRuntime implements AgentRuntime {
  readonly calls: RuntimeCall[] = [];
  readonly agents = new Map<string, AgentObservation>();
  readonly credentials = new Map<string, RelayCredentials>();
  readiness: ProviderReadiness = { status: 'authenticated', message: 'Signed in.', models: [] };
  probes = 0;
  /** Thrown from the next launch, once. */
  failNextLaunch: Error | null = null;
  /** Agents whose observe() throws. */
  readonly observeFailures = new Map<string, Error>();
  /** What the controller gave it to open each agent's event stream. */
  openStream: ((agentId: string) => OpenAgentStream) | null = null;
  closed = false;

  /** For `ControllerDeps.runtime`: keeps the stream opener the controller hands over. */
  readonly build = (openStream: (agentId: string) => OpenAgentStream): FakeRuntime => {
    this.openStream = openStream;
    return this;
  };

  async close(): Promise<void> {
    this.closed = true;
  }

  observation(agentId: string): AgentObservation {
    let current = this.agents.get(agentId);
    if (!current) {
      current = emptyObservation();
      this.agents.set(agentId, current);
    }
    return current;
  }

  async observe(agentId: string): Promise<AgentObservation> {
    const failure = this.observeFailures.get(agentId);
    if (failure) throw failure;
    return structuredClone(this.observation(agentId));
  }

  watcherRoot(agentId: string): string {
    return `/data/watchers/${agentId}`;
  }

  credentialsPath(agentId: string): string {
    return `/data/agents/${agentId}/credentials.json`;
  }

  async readCredentials(agentId: string): Promise<RelayCredentials | null> {
    return this.credentials.get(agentId) ?? null;
  }

  async writeCredentials(agentId: string, credentials: RelayCredentials) {
    this.calls.push({ kind: 'writeCredentials', agentId, ...credentials });
    this.credentials.set(agentId, credentials);
  }

  async deleteCredentials(agentId: string): Promise<void> {
    this.calls.push({ kind: 'deleteCredentials', agentId });
    this.credentials.delete(agentId);
  }

  async workingDirectory(name: string, directory: string | null): Promise<string> {
    if (directory === null) return `/data/workspaces/${name}`;
    if (!directory.startsWith('/'))
      throw new ReasonedError('definition_invalid', `'${directory}' is not absolute.`);
    return directory;
  }

  async launch(agentId: string, template: SharedHostConfig, options: LaunchOptions) {
    this.calls.push({ kind: 'launch', agentId, template, options });
    if (this.failNextLaunch) {
      const error = this.failNextLaunch;
      this.failNextLaunch = null;
      throw error;
    }
    const observation = this.observation(agentId);
    Object.assign(observation, {
      alive: true,
      configured: { provider: template.start.provider, cwd: template.start.input.cwd },
      flags: { enabled: true, spawn: true },
      failure: null,
      takenOver: options.clearTakenOver ? null : observation.takenOver,
      health: {
        state: 'connected',
        detail: null,
        since: new Date(0).toISOString(),
        placements: {},
        pid: 4242,
        updatedAt: new Date(0).toISOString(),
        current: true,
      },
    } satisfies Partial<AgentObservation>);
  }

  async stop(agentId: string, options: { wait: boolean }): Promise<void> {
    this.calls.push({ kind: 'stop', agentId, wait: options.wait });
    const observation = this.observation(agentId);
    observation.alive = false;
    observation.flags = { enabled: false, spawn: false };
    if (observation.health)
      observation.health = { ...observation.health, state: 'disabled', current: false };
  }

  async probe(_provider: Provider, _binaryPath: string, _cwd: string): Promise<ProviderReadiness> {
    this.probes++;
    return this.readiness;
  }

  /** Simulates the watcher dying: with a failure message, or silently (a reboot). */
  kill(agentId: string, failure: string | null): void {
    const observation = this.observation(agentId);
    observation.alive = false;
    observation.failure = failure;
    if (observation.health) observation.health = { ...observation.health, current: false };
  }

  launches(agentId?: string) {
    return this.calls.filter(
      (call): call is Extract<RuntimeCall, { kind: 'launch' }> =>
        call.kind === 'launch' && (agentId === undefined || call.agentId === agentId)
    );
  }
}

/** Every provider installed at `/usr/bin/<provider>`, unless listed as missing. */
export class FakeLocator implements ProviderLocator {
  readonly authSource = 'local';
  readonly missing = new Set<Provider>();

  async locate(provider: Provider): Promise<LocatedProvider | null> {
    if (this.missing.has(provider)) return null;
    return { path: `/usr/bin/${provider}`, version: '1.2.3' };
  }
}
