import { mkdir } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import {
  type ProviderReadiness,
  providerReadinessSchema,
  type SharedHostConfig,
} from '@switch-console/agent-providers-box';
import { ReasonedError } from './errors';
import type { LauncherLink } from './launcher-link';
import { credentialsCrossing, type LauncherRunner } from './launcher-runner';
import { agentWorkspace, type DataLayout } from './paths';
import {
  type AgentObservation,
  type AgentRuntime,
  type LaunchOptions,
  parseRelayCredentials,
  type RelayCredentials,
  readOptional,
  relayCredentialsBody,
  removeOptional,
  writeAtomic,
} from './runtime';
import type { Provider } from './schemas';
import type { GivenLogin } from './sealed-logins';

/** Hub-refused tickets (`spent`, `wrong_agent`) that mark an agent failed, and over how long. */
export const BURNT_LIMIT = 3;
export const BURNT_WINDOW_MS = 10 * 60_000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;

/**
 * When an agent's host may be started again on a split box.
 * Only a ticket the controller minted that the hub then refused as `spent` or
 * `wrong_agent` counts towards failure: three in ten minutes and the agent is
 * failed until its owner changes it. Anything else (`unknown`, `missing`,
 * `expired`, a stale launch, a host that never confirmed its key or had a
 * control port not its own, or one that simply went) is a relaunch after a
 * backoff that doubles, and resets once a host says hello with a good ticket.
 */
export class LaunchGate {
  private readonly burnt = new Map<string, number[]>();
  private readonly failed = new Set<string>();
  private readonly backoff = new Map<string, { count: number; until: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A minted ticket refused at the hub as spent or another agent's: failed, or how long until a relaunch. */
  burn(agentId: string): 'failed' | number {
    const now = this.now();
    const recent = (this.burnt.get(agentId) ?? []).filter((at) => now - at < BURNT_WINDOW_MS);
    recent.push(now);
    this.burnt.set(agentId, recent);
    if (recent.length >= BURNT_LIMIT) {
      this.failed.add(agentId);
      return 'failed';
    }
    return this.delay(agentId);
  }

  /** A relaunch is due: how long to wait first, doubling each time. */
  delay(agentId: string): number {
    const count = (this.backoff.get(agentId)?.count ?? 0) + 1;
    const wait = Math.min(BACKOFF_BASE_MS * 2 ** (count - 1), BACKOFF_MAX_MS);
    this.backoff.set(agentId, { count, until: this.now() + wait });
    return wait;
  }

  /** A host said hello with a good ticket: it is up, and the backoff starts again. */
  taken(agentId: string): void {
    this.backoff.delete(agentId);
  }

  /** The agent's owner changed it: a failure is lifted. */
  clear(agentId: string): void {
    this.failed.delete(agentId);
    this.burnt.delete(agentId);
    this.backoff.delete(agentId);
  }

  isFailed(agentId: string): boolean {
    return this.failed.has(agentId);
  }

  /** Throws while the agent is failed, or still waiting out its backoff. */
  check(agentId: string): void {
    if (this.failed.has(agentId))
      throw new ReasonedError(
        'internal',
        `This agent's launch tickets were refused ${BURNT_LIMIT} times in ${BURNT_WINDOW_MS / 60_000} minutes, so it is not being started again until it is changed.`
      );
    const until = this.backoff.get(agentId)?.until ?? 0;
    const wait = until - this.now();
    if (wait > 0)
      throw new ReasonedError(
        'crash_loop',
        `This agent's host is started again in ${Math.ceil(wait / 1000)} s.`
      );
  }
}

/** A gateway probe for one sign-in check: the CLI environment, and how to end it (`gatewayProbe`). */
export type ProbeEnv = (
  provider: Provider,
  login: GivenLogin
) => Promise<{ env: Record<string, string>; done: () => void } | null>;

/**
 * How agents run on a box where the controller is its own user: every
 * agent host in the agents container, through the launcher, login or not. No
 * host runs in this process, since here it would hold this user's secrets.
 *
 * Two disks: the controller keeps each agent's relay credentials on its own,
 * and the paths it writes into a host's template are the agents container's
 * (`agents`), where the launcher writes and the host reads them.
 */
export class SplitRuntime implements AgentRuntime {
  /** Each agent's relay credentials, as last read or written: the launcher sends them at launch. */
  private readonly credentials = new Map<string, RelayCredentials>();
  private probeEnv: ProbeEnv | undefined;

  constructor(
    private readonly deps: {
      runner: LauncherRunner;
      link: Pick<LauncherLink, 'order'>;
      /** The controller's own data folder, where credentials are kept. */
      store: DataLayout;
      /** The agents' data folder as the agents container sees it. */
      agents: DataLayout;
      /** Where agents naming no directory work, as the agents container sees it. */
      workspaces: string;
      gate?: LaunchGate;
      /** A given login's sign-in check goes through the gateway; absent, it is reported unknown. */
      probeEnv?: ProbeEnv;
    }
  ) {
    this.probeEnv = deps.probeEnv;
  }

  /**
   * Set once the provider gateway is up (it starts inside `runController`,
   * after this runtime is made): a given login's sign-in check then goes
   * through a gateway probe token.
   */
  setProbeEnv(probeEnv: ProbeEnv | undefined): void {
    this.probeEnv = probeEnv;
  }

  /** For the runner, at launch: the agent's relay credentials, or null. */
  credentialsFor(agentId: string): RelayCredentials | null {
    return this.credentials.get(agentId) ?? null;
  }

  observe(agentId: string): Promise<AgentObservation> {
    return this.deps.runner.observe(agentId);
  }

  /** Always in a process of its own, in the agents container: nothing runs in this one. */
  async launch(agentId: string, template: SharedHostConfig, options: LaunchOptions): Promise<void> {
    this.deps.gate?.check(agentId);
    await this.deps.runner.launch(agentId, template, { ...options, isolation: 'isolated' });
  }

  stop(agentId: string, options: { wait: boolean; asked?: boolean }): Promise<void> {
    return this.deps.runner.stop(agentId, options);
  }

  async close(): Promise<void> {
    await this.deps.runner.close();
  }

  /** Where the host reads them: the launcher writes them there at launch. */
  credentialsPath(agentId: string): string {
    return this.deps.agents.agentCredentials(agentId);
  }

  async readCredentials(agentId: string): Promise<RelayCredentials | null> {
    const text = await readOptional(this.deps.store.agentCredentials(agentId));
    const credentials = text === null ? null : parseRelayCredentials(text, agentId);
    if (credentials) this.credentials.set(agentId, credentials);
    else this.credentials.delete(agentId);
    return credentials;
  }

  async writeCredentials(agentId: string, credentials: RelayCredentials): Promise<void> {
    await mkdir(this.deps.store.agentDir(agentId), { recursive: true, mode: 0o700 });
    await writeAtomic(
      this.deps.store.agentCredentials(agentId),
      relayCredentialsBody(agentId, credentials)
    );
    this.credentials.set(agentId, credentials);
  }

  async deleteCredentials(agentId: string): Promise<void> {
    this.credentials.delete(agentId);
    await removeOptional(this.deps.store.agentCredentials(agentId));
  }

  /**
   * The path only: the launcher makes it at launch when it is inside the
   * workspaces folder, and any other must already exist there.
   */
  async workingDirectory(
    _agentId: string,
    name: string,
    directory: string | null
  ): Promise<string> {
    if (directory === null) return agentWorkspace(this.deps.workspaces, name);
    if (!isAbsolute(directory))
      throw new ReasonedError(
        'definition_invalid',
        `The working directory '${directory}' is not an absolute path.`
      );
    return resolve(directory);
  }

  /**
   * Run in the agents container, never here: a provider's CLI never runs as
   * the controller's user on this box. A given login is checked through the
   * gateway: the CLI gets a short-lived probe token, never the login, and the
   * probe is ended when the check is.
   */
  async probe(
    provider: Provider,
    binaryPath: string,
    _cwd: string,
    login: GivenLogin | null
  ): Promise<ProviderReadiness> {
    const unknown = (message: string): ProviderReadiness => ({
      status: 'unknown',
      message,
      models: [],
    });
    let probe: { env: Record<string, string>; done: () => void } | null = null;
    if (login) {
      probe = this.probeEnv ? await this.probeEnv(provider, login) : null;
      if (!probe)
        return unknown(
          'This login cannot be checked on this box: it doesn’t go through the provider gateway.'
        );
    }
    try {
      // The same rule as a launch: only empty values or gateway tokens
      // in credential-carrying variables, or nothing is sent.
      const crossing = credentialsCrossing(probe?.env ?? {});
      if (crossing.length > 0)
        return unknown(
          `Not checked: the probe would carry a credential (${crossing.join(', ')}) into the agents container.`
        );
      const reply = await this.deps.link.order({
        kind: 'probe',
        provider,
        binaryPath,
        env: probe?.env ?? {},
      });
      if (!reply.ok) return unknown(`The sign-in check did not run (${reply.code ?? 'failed'}).`);
      const readiness = providerReadinessSchema.strict().safeParse(reply.readiness);
      return readiness.success
        ? readiness.data
        : unknown('The sign-in check gave an answer that could not be read.');
    } finally {
      probe?.done();
    }
  }

  agentStateRoot(agentId: string): string {
    return this.deps.agents.watcherRoot(agentId);
  }

  /** Through the launcher, which asks the host on its control port. */
  async warm(agentId: string, roomId: string): Promise<void> {
    const reply = await this.deps.link.order({ kind: 'warm', agentId, roomId });
    if (!reply.ok)
      throw new Error(`The agent host did not warm the room (${reply.code ?? 'failed'}).`);
  }

  /** The memory guard is stopping the agent: its host tells its rooms, through the launcher. */
  async stopForMemory(agentId: string): Promise<number> {
    const reply = await this.deps.link.order({ kind: 'memory_notice', agentId });
    if (!reply.ok)
      throw new Error(`The agent host did not tell its rooms (${reply.code ?? 'failed'}).`);
    return reply.told ?? 0;
  }
}
