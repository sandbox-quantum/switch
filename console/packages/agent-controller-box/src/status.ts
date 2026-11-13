import { mkdir, statfs } from 'node:fs/promises';
import { arch, freemem, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import {
  execProvider,
  findOnPath,
  type ProviderReadiness,
  providerUnsupportedReason,
  readCliToolStatuses,
  verifyClaudeSignIn,
} from '@switch-console/agent-providers-box';
import { pluginRegistry } from '@switch-console/plugins/agents';
import { errorMessage, type Logger } from './log';
import type { LoginCheck, LoginVerdict } from './login-check';
import { type MeminfoReading, readMeminfo } from './meminfo';
import type { BoxNote } from './memory-guard';
import type { RestState } from './rest';
import type { AgentObservation, AgentRuntime } from './runtime';
import {
  type AgentAssignment,
  type AgentStatus,
  type Assignment,
  type Platform,
  type ProcessState,
  isProvider,
  PROTOCOL_VERSION,
  type Provider,
  PROVIDERS,
  type ProviderStatus,
  type ReasonCode,
  type StatusReport,
  type ToolStatus,
  type UpdatedBy,
} from './schemas';
import type { GivenLogin, LoginProblem, SealedLogins } from './sealed-logins';
import type { AgentRow, ControllerStore } from './store';

export const PROVIDER_TTL_MS = 10 * 60 * 1000;
// A first run may unpack the CLI's own runtime (OpenCode's Bun) before printing.
const VERSION_TIMEOUT_MS = 30_000;
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

/** A provider's CLI, its version, and why none was read when it was not. */
export type LocatedProvider = {
  path: string;
  version: string | null;
  versionProblem: string | null;
};

/**
 * The tools Switch sets up for a session whose agent has a GitHub grant: `ok`
 * when on PATH, `missing` when not. Its helpers do not run on Windows, so
 * there both are `unsupported`, and such an agent uses the machine's own
 * sign-in.
 *
 * Then each vendor command-line tool a session here has set up, from the
 * machine's tool folder (`cliToolsBase`): `ok` once its pinned build is
 * installed, `missing` when the last install failed, `unsupported` where the
 * catalog has no build for this machine. A tool no session has needed yet is
 * not named.
 */
export async function toolStatuses(
  path: string | undefined,
  os: NodeJS.Platform,
  cliBase: string
): Promise<ToolStatus[]> {
  return [...(await gitHubToolStatuses(path, os)), ...(await readCliToolStatuses(cliBase))];
}

async function gitHubToolStatuses(
  path: string | undefined,
  os: NodeJS.Platform
): Promise<ToolStatus[]> {
  const tools = ['git', 'gh'];
  if (os === 'win32') return tools.map((tool) => ({ tool, state: 'unsupported' }));
  return Promise.all(
    tools.map(
      async (tool) =>
        ({ tool, state: (await findOnPath(tool, path)) !== null ? 'ok' : 'missing' }) as const
    )
  );
}

/** Finds a provider's CLI on this machine. */
export interface ProviderLocator {
  locate(provider: Provider): Promise<LocatedProvider | null>;
}

/**
 * Looks each provider's CLI up on `PATH` under the names its plugin declares,
 * as Console's dependency detection does, and asks it for its version. `path`
 * is read on every lookup, so a PATH refreshed since start is the one used.
 */
/**
 * Where an agent's sessions stand, the most awake first, from its live
 * watcher's own report: `waking`, then `active`, then `parked`. Null when the
 * watcher is not live, reports no sessions, or is too old to report them.
 */
export function sessionStateOf(
  observation: AgentObservation
): 'active' | 'waking' | 'parked' | null {
  if (!observation.alive || !observation.health?.current) return null;
  const states = Object.values(observation.health.sessions ?? {});
  if (states.includes('waking')) return 'waking';
  if (states.includes('active')) return 'active';
  if (states.includes('parked')) return 'parked';
  return null;
}

/**
 * How many of an agent's sessions are awake (active or waking). A host too old
 * to say where its sessions stand counts every placement, as before, so it is
 * never taken for idle.
 */
export function awakeSessions(
  health: NonNullable<AgentObservation['health']>,
  placements: number
): number {
  if (!health.sessions) return placements;
  return Object.values(health.sessions).filter((state) => state !== 'parked').length;
}

export class PathProviderLocator implements ProviderLocator {
  /**
   * `probeHome` is the home CLIs run with to print their version: some
   * (OpenCode) write there before printing, and the controller's user may have
   * none it can write in. Kept between probes, so a runtime a CLI unpacks on
   * its first run is unpacked once.
   */
  constructor(
    private readonly path: () => string | undefined,
    private readonly probeHome: string
  ) {}

  async locate(provider: Provider): Promise<LocatedProvider | null> {
    const plugin = pluginRegistry.get(provider);
    if (!plugin) throw new Error(`No provider plugin is registered for '${provider}'.`);
    const dependency = plugin.capabilities.hostDependency;
    if (providerUnsupportedReason(provider, process.platform) !== null) return null;
    for (const name of dependency.binaryNames) {
      const candidate = await findOnPath(name, this.path());
      if (candidate === null) continue;
      if (dependency.skipVersionProbe)
        return { path: candidate, version: null, versionProblem: null };
      return {
        path: candidate,
        ...(await readVersion(candidate, dependency.versionArgs ?? ['--version'], this.probeHome)),
      };
    }
    return null;
  }
}

/** The version a CLI prints, or why none could be read. */
async function readVersion(
  binary: string,
  args: string[],
  home: string
): Promise<{ version: string | null; versionProblem: string | null }> {
  try {
    await mkdir(home, { recursive: true, mode: 0o700 });
    const { stdout, stderr } = await execProvider(binary, args, {
      timeout: VERSION_TIMEOUT_MS,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_DATA_HOME: join(home, '.local', 'share'),
        XDG_STATE_HOME: join(home, '.local', 'state'),
        XDG_CACHE_HOME: join(home, '.cache'),
      },
    });
    const output = `${stdout}\n${stderr}`;
    const version = output.match(/\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/)?.[0] ?? null;
    return version
      ? { version, versionProblem: null }
      : { version: null, versionProblem: `printed no version: ${lastLine(output)}` };
  } catch (error) {
    const failed = error as NodeJS.ErrnoException & {
      killed?: boolean;
      code?: number | string;
      stderr?: string;
      stdout?: string;
    };
    const versionProblem = failed.killed
      ? `timed out after ${VERSION_TIMEOUT_MS / 1000} s`
      : typeof failed.code === 'number'
        ? `exited ${failed.code}: ${lastLine(`${failed.stdout ?? ''}\n${failed.stderr ?? ''}`)}`
        : errorMessage(error);
    return { version: null, versionProblem: versionProblem.slice(0, 300) };
  }
}

function lastLine(output: string): string {
  return (
    output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? '(nothing)'
  );
}

export function providerStatusFrom(
  provider: Provider,
  located: LocatedProvider | null,
  readiness: ProviderReadiness | null,
  checkedAt: string
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
  const base = {
    provider,
    installed: true,
    version: located.version,
    ...(located.versionProblem ? { version_problem: located.versionProblem } : {}),
    checked_at: checkedAt,
  };
  if (!readiness) return { ...base, auth: 'unknown', auth_source: null, reason: 'internal' };
  const said = readiness.message ? { auth_problem: readiness.message.slice(0, 300) } : {};
  switch (readiness.status) {
    case 'authenticated':
      return { ...base, auth: 'ok', auth_source: 'local' };
    case 'unauthenticated':
    case 'unconfigured':
      return {
        ...base,
        auth: 'missing',
        auth_source: null,
        reason: 'provider_login_missing',
        ...said,
        ...(readiness.loginHelps === false ? { login_helps: false } : {}),
      };
    case 'unknown':
      return {
        ...base,
        auth: 'unknown',
        auth_source: null,
        ...said,
        ...(readiness.loginHelps === false ? { login_helps: false } : {}),
      };
  }
}

/**
 * A provider as last checked: its status, its CLI, the login Switch gave the
 * machine when that is what agents use, and why a given login is not used.
 */
/** Provider checks made elsewhere, for {@link ProviderStatuses.seed}: each status and where its CLI was found. */
export type ProviderSeed = { status: ProviderStatus; path: string | null }[];

type ProviderEntry = {
  status: ProviderStatus;
  path: string | null;
  at: number;
  login: GivenLogin | null;
  problem:
    | LoginProblem
    | { code: 'provider_login_expired' | 'login_rejected' | 'login_not_checked'; message: string }
    | null;
  /** Which check this is, in the order they started. */
  sequence: number;
};

/**
 * Why a given login can't be used on this machine, and what to give instead, in
 * words main's Console shows as they are. Nothing of the login itself.
 */
export function unusableLoginMessage(login: Pick<GivenLogin, 'provider' | 'kind'>): string {
  if (login.provider === 'codex' && login.kind === 'auth-json')
    return "This cloud machine can't use Codex's 'This computer's sign-in'. Give it an OpenAI API key instead.";
  if (login.provider === 'claude' && login.kind === 'vertex')
    return "This cloud machine can't use Vertex AI in this login's region. Give it a Claude setup token or API key, or a Vertex AI login in a region with its own endpoint.";
  return `This cloud machine can't use this ${login.provider} login. Give it an API key instead.`;
}

/** Fixed words: nothing Google said, and nothing of the key. */
const LOGIN_REJECTED = "Google didn't accept this key.";
const LOGIN_NOT_CHECKED = "Couldn't reach Google to check this key. It will be checked again.";

/**
 * Each provider's installation and login, checked at most every ten minutes
 * unless a recheck is forced. A check that finds something different calls
 * `onChange`, so the next status report carries it.
 *
 * The machine's own login comes first: an agent uses a login Switch gave the
 * machine (`sealed`) only for a provider it has none of its own for, and only
 * once the provider signs in with it.
 */
export class ProviderStatuses {
  private readonly entries = new Map<Provider, ProviderEntry>();
  private refreshing: Promise<void> | null = null;
  /** Each provider's given-login verdict, by revision (`loginVerdict`). */
  private readonly verdicts = new Map<Provider, { revision: string; verdict: 'ok' | 'rejected' }>();
  private givenDisabled = false;
  private checks = 0;

  constructor(
    private readonly deps: {
      locator: ProviderLocator;
      runtime: Pick<AgentRuntime, 'probe'>;
      /**
       * A real test of a provider's own login (one short prompt), for those
       * whose status command only says a login is there. Null when the
       * provider has none. Costs a request, so `check` runs it only when
       * asked to or when the login was not already known to work.
       */
      verify?: (provider: Provider, binaryPath: string) => Promise<ProviderReadiness> | null;
      /** The logins Switch gives this machine; null when it cannot open any. */
      sealed: SealedLogins | null;
      /**
       * Whether this machine can use a given login: with the provider gateway
       * on, only one the gateway can front. Absent: any login can be used.
       */
      usable?: (login: GivenLogin) => boolean;
      /**
       * A given login's own check with its provider, after the CLI signs in
       * with it (a Vertex AI login asks Google for a token). Absent: the CLI's
       * check is the whole check.
       */
      checkLogin?: LoginCheck;
      probeCwd: string;
      now: () => number;
      log: Logger;
      onChange: () => void;
    }
  ) {}

  /**
   * Takes provider checks made before this controller started (Switch
   * Console's, as onboarding opens) as its own, so its first report already
   * carries them rather than waiting on checks of its own.
   *
   * Only what no login given to the machine could change: a provider signed
   * in on its own, or not installed. Any other is checked here as usual, and
   * so is one already checked here or checked longer ago than the TTL.
   */
  seed(seeds: ProviderSeed): void {
    let changed = false;
    for (const { status, path } of seeds) {
      if (!isProvider(status.provider) || this.entries.has(status.provider)) continue;
      const own = status.auth === 'ok' && status.auth_source === 'local';
      if (!own && status.installed) continue;
      const at = Date.parse(status.checked_at);
      if (!Number.isFinite(at) || this.deps.now() - at >= PROVIDER_TTL_MS) continue;
      this.entries.set(status.provider, {
        status,
        path,
        at,
        login: null,
        problem: null,
        sequence: 0,
      });
      changed = true;
    }
    if (changed) this.deps.onChange();
  }

  /** Every check made so far, with where each provider's CLI was found: what `seed` takes. */
  results(): ProviderSeed {
    return PROVIDERS.flatMap((provider) => {
      const entry = this.entries.get(provider);
      return entry ? [{ status: entry.status, path: entry.path }] : [];
    });
  }

  /**
   * Checks one provider now, its own login first, then one given to the
   * machine. With `verify`, a login the provider says it has is also tried
   * with a test prompt; without it, only when it was not already known to work.
   */
  async check(provider: Provider, options: { verify?: boolean } = {}): Promise<ProviderStatus> {
    const sequence = ++this.checks;
    const at = this.deps.now();
    const checkedAt = new Date(at).toISOString();
    const located = await this.deps.locator.locate(provider);
    let readiness = located ? await this.probe(provider, located.path, null) : null;
    const knownToWork = this.entries.get(provider)?.status;
    if (
      located &&
      readiness?.status === 'authenticated' &&
      (options.verify || !(knownToWork?.auth === 'ok' && knownToWork.auth_source === 'local'))
    )
      readiness = (await this.tryLogin(provider, located.path)) ?? readiness;
    let status = providerStatusFrom(provider, located, readiness, checkedAt);
    let login: GivenLogin | null = null;
    let problem: ProviderEntry['problem'] = null;
    // The sign-in check of a given login did not run: not cached (see below).
    let unchecked = false;
    if (
      located &&
      readiness?.status !== 'authenticated' &&
      this.deps.sealed &&
      !this.givenDisabled
    ) {
      const given = await this.fetchGiven(provider);
      if (given && 'login' in given && this.deps.usable && !this.deps.usable(given.login)) {
        // A login this machine can't use (with the provider gateway on, one it
        // can't front) is refused at once, saying why and what to give instead,
        // rather than as a sign-in check that "did not run".
        const message = unusableLoginMessage(given.login);
        problem = { code: 'provider_login_missing', message };
        status = {
          ...status,
          auth: 'missing',
          auth_source: 'sealed',
          reason: 'provider_login_missing',
          auth_problem: message,
        };
      } else if (given && 'login' in given) {
        let signedIn = await this.probe(provider, located.path, given.login);
        let verdict: LoginVerdict = 'ok';
        if (signedIn?.status === 'authenticated') {
          verdict = await this.loginVerdict(provider, given.login, options.verify === true);
          if (verdict === 'unreachable')
            // Nothing is known about the key: handled as a check that didn't run.
            signedIn = { status: 'unknown', message: '', models: [] };
        }
        if (verdict === 'rejected') {
          problem = { code: 'login_rejected', message: LOGIN_REJECTED };
          status = {
            ...status,
            auth: 'expired',
            auth_source: 'sealed',
            reason: 'provider_login_expired',
            auth_problem: LOGIN_REJECTED,
          };
        } else if (signedIn?.status === 'authenticated') {
          login = given.login;
          // What the machine's own check said is not about the login agents use now.
          status = {
            ...status,
            auth: 'ok',
            auth_source: 'sealed',
            reason: undefined,
            auth_problem: undefined,
          };
        } else if (signedIn === null || signedIn.status === 'unknown') {
          // The sign-in check did not run: on a split box, the agents
          // container's launcher isn't linked yet, as just after the box wakes.
          // That says nothing about the login, so it isn't marked expired. A
          // login held from a check that signed in, at this revision, is kept;
          // otherwise none is used yet. Either way the result isn't cached, so
          // the next use checks again (login-after-wake defect, 1 Nov).
          unchecked = true;
          const held = this.entries.get(provider);
          const kept =
            held?.login &&
            held.status.auth === 'ok' &&
            held.status.auth_source === 'sealed' &&
            held.login.revision === given.login.revision
              ? held.login
              : null;
          login = kept;
          // A revision Google already accepted stays in use meanwhile.
          if (verdict === 'unreachable' && !kept)
            problem = { code: 'login_not_checked', message: LOGIN_NOT_CHECKED };
          status = kept
            ? {
                ...status,
                auth: 'ok',
                auth_source: 'sealed',
                reason: undefined,
                auth_problem: undefined,
              }
            : {
                ...status,
                auth: 'unknown',
                auth_source: 'sealed',
                reason: undefined,
                auth_problem:
                  verdict === 'unreachable'
                    ? LOGIN_NOT_CHECKED
                    : `The sign-in check of the ${provider} login given to this machine did not run.`,
              };
        } else {
          problem = {
            code: 'provider_login_expired',
            message: `The ${provider} login given to this machine does not sign in${signedIn?.message ? `: ${signedIn.message}` : '.'}`,
          };
          status = {
            ...status,
            auth: 'expired',
            auth_source: 'sealed',
            reason: 'provider_login_expired',
            auth_problem: problem.message.slice(0, 300),
          };
        }
      } else if (given) {
        problem = given.problem;
        if (problem) status = { ...status, auth_problem: problem.message.slice(0, 300) };
      } else {
        const held = this.entries.get(provider);
        login = held?.login ?? null;
        problem = held?.problem ?? null;
        if (held?.status.auth_source === 'sealed')
          status = {
            ...status,
            auth: held.status.auth,
            auth_source: 'sealed',
            reason: held.status.reason,
            ...(held.status.auth_problem ? { auth_problem: held.status.auth_problem } : {}),
          };
      }
    }
    if (status.reason === undefined) delete status.reason;
    if (status.auth_problem === undefined) delete status.auth_problem;
    // Said of the machine's own login, which a given login now stands in for.
    if (status.auth_source === 'sealed') delete status.login_helps;
    const previous = this.entries.get(provider);
    // A check that started before the one already recorded knows less.
    if (previous && previous.sequence > sequence) return previous.status;
    this.entries.set(provider, {
      status,
      path: located?.path ?? null,
      // A check that couldn't try the given login is stale at once.
      at: unchecked ? at - PROVIDER_TTL_MS : at,
      login,
      problem,
      sequence,
    });
    if (
      !previous ||
      fingerprintProvider(previous.status) !== fingerprintProvider(status) ||
      previous.login?.revision !== login?.revision
    )
      this.deps.onChange();
    return status;
  }

  /**
   * The login Switch gave the machine for `provider`, when that is what its
   * agents use: null when they use the machine's own, or there is none.
   * Checks first when the provider never was, or the check is stale.
   */
  async givenLogin(provider: Provider): Promise<GivenLogin | null> {
    const entry = this.entries.get(provider);
    if (!entry || this.deps.now() - entry.at >= PROVIDER_TTL_MS) await this.check(provider);
    return this.entries.get(provider)?.login ?? null;
  }

  /**
   * Whether a login given to the machine is waiting on a sign-in check that
   * could not run (`unknown`, from Switch): the controller tries it again.
   */
  hasUnchecked(): boolean {
    for (const entry of this.entries.values())
      if (entry.status.auth === 'unknown' && entry.status.auth_source === 'sealed') return true;
    return false;
  }

  /** Stops using logins given to the machine: Switch could not take this machine's key. */
  disableGiven(): void {
    this.givenDisabled = true;
    for (const entry of this.entries.values()) entry.login = null;
    this.deps.onChange();
  }

  /** Why the login given to the machine for `provider` is not used, as last checked. */
  loginProblem(provider: Provider): ProviderEntry['problem'] {
    return this.entries.get(provider)?.problem ?? null;
  }

  /**
   * The given login's own check. A forced check (`verify`, as when a login is
   * given or rechecked) always asks again; otherwise an ok or rejected answer
   * for the same revision stands. Unreachable is never kept.
   */
  private async loginVerdict(
    provider: Provider,
    login: GivenLogin,
    verify: boolean
  ): Promise<LoginVerdict> {
    const check = this.deps.checkLogin;
    if (!check) return 'ok';
    const kept = this.verdicts.get(provider);
    if (!verify && kept && kept.revision === login.revision) return kept.verdict;
    let verdict: LoginVerdict;
    try {
      verdict = await check(login);
    } catch {
      verdict = 'unreachable';
    }
    if (verdict === 'unreachable') this.verdicts.delete(provider);
    else this.verdicts.set(provider, { revision: login.revision, verdict });
    // Only the verdict: never the key, nor anything Google said.
    if (verdict !== 'ok')
      this.deps.log.warn('A login given to this machine did not pass its check', {
        provider,
        verdict,
      });
    return verdict;
  }

  /** The test prompt's answer, or null when the provider has none or it could not run. */
  private async tryLogin(provider: Provider, path: string): Promise<ProviderReadiness | null> {
    try {
      return (await this.deps.verify?.(provider, path)) ?? null;
    } catch (error) {
      this.deps.log.warn('Could not try a provider’s login with a test prompt', {
        provider,
        error: errorMessage(error),
      });
      return null;
    }
  }

  private async probe(
    provider: Provider,
    path: string,
    login: GivenLogin | null
  ): Promise<ProviderReadiness | null> {
    try {
      return await this.deps.runtime.probe(provider, path, this.deps.probeCwd, login);
    } catch (error) {
      this.deps.log.warn('Could not check a provider’s login', {
        provider,
        given: login !== null,
        error: errorMessage(error),
      });
      return null;
    }
  }

  /** The given login, or why there is none; null when Switch could not be asked, keeping what was held. */
  private async fetchGiven(
    provider: Provider
  ): Promise<{ login: GivenLogin } | { problem: LoginProblem } | null> {
    try {
      const given = await this.deps.sealed!.fetch(provider);
      if ('problem' in given && given.problem.code === 'internal')
        this.deps.log.error('A login given to this machine cannot be opened', {
          provider,
          error: given.problem.message,
        });
      return given;
    } catch (error) {
      this.deps.log.warn('Could not fetch the login given to this machine; keeping the one held', {
        provider,
        error: errorMessage(error),
      });
      return null;
    }
  }

  /** Checks every provider now, whatever its last check, all at once. */
  async checkAll(options: { verify?: boolean } = {}): Promise<void> {
    await Promise.all(PROVIDERS.map((provider) => this.check(provider, options)));
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
  return JSON.stringify([
    status.installed,
    status.version,
    status.auth,
    status.reason ?? null,
    status.auth_problem ?? null,
    status.login_helps ?? null,
  ]);
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

/**
 * The rest state that stands in for what the agent host reports: a resting
 * agent, or one woken from a rest whose host is not connected yet (bounded by
 * `WAKE_GRACE_MS` in `AgentRest.state`). Never for an agent its owner stopped.
 */
export function restStandsIn(
  rest: RestState | null,
  assignment: AgentAssignment,
  observation: AgentObservation
): (RestState & { kind: 'resting' | 'waking' }) | null {
  if (!rest || assignment.desired_state === 'stopped') return null;
  if (rest.kind === 'resting') return rest;
  if (rest.kind !== 'waking') return null;
  const connected =
    observation.alive &&
    observation.health?.current === true &&
    observation.health.state === 'connected';
  return connected ? null : rest;
}

/** One agent's process state in the contract's terms, from what the controller recorded and sees. */
export function mapAgentProcess(input: {
  assignment: AgentAssignment;
  row: AgentRow | null;
  observation: AgentObservation;
  /** The agent's events flow on the controller stream and its agent host is taking them. */
  relayAttached: boolean;
  nowMs: number;
  /** Resting, or waking from a rest, as `AgentRest` holds it; absent where agents do not rest. */
  rest?: RestState | null;
  /** Switch has the agent attached on a connected controller stream, host or not. */
  streamCarries?: boolean;
  /**
   * The memory guard's detail while it holds the agent stopped (until its
   * next message), or null. Below an owner's stop and a failure, above the rest.
   */
  guardStop?: string | null;
}): Mapped {
  const { assignment, row, observation } = input;
  // A failure recorded at this revision wins over resting and waking, so a
  // host that will not start always shows as failed.
  if (row?.failure && row.failure.revision === assignment.revision)
    return {
      process: 'failed',
      attached: false,
      reason: row.failure.reason,
      detail: truncate(row.failure.detail),
    };
  const desiredStopped = assignment.desired_state === 'stopped';
  if (restStandsIn(input.rest ?? null, assignment, observation))
    // Its host is stopped on purpose (or coming back for a message) and its
    // events are held: running, as Core and Console must read it, never stopped.
    return { process: 'running', attached: input.streamCarries ?? false };
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
  if (input.guardStop)
    return {
      process: 'stopped',
      attached: false,
      reason: 'out_of_memory',
      detail: truncate(input.guardStop),
    };
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
 * Whether no session here is in the middle of a turn, as each assigned
 * agent's host last reported it: what a controller waits for before it
 * restarts into another release. Idle sessions do not hold it back; they are
 * restarted with it and resume their conversations. An agent host too old to
 * report which sessions are busy holds it back while it has any session at
 * all. An agent host not running, or whose report is not its own, has none.
 */
export function noSessionMidTurn(observations: AgentObservation[]): boolean {
  return observations.every((observation) => {
    const health = observation.alive && observation.health?.current ? observation.health : null;
    if (!health) return true;
    if (health.busy) return health.busy.length === 0;
    return Object.keys(health.placements).length === 0;
  });
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
      /** The tools sessions are set up with (`toolStatuses`). */
      tools: () => Promise<ToolStatus[]>;
      /** Whether the relay has the agent attached; see `mapAgentProcess`. */
      attached: (agentId: string) => boolean;
      /** Resting or waking from a rest; absent where agents do not rest. */
      rest?: (agentId: string) => RestState | null;
      /** Switch has the agent attached on a connected controller stream, host or not. */
      streamCarries?: (agentId: string) => boolean;
      dataDir: string;
      /**
       * Split boxes: the agents' disk, as the launcher measures it
       * (`AgentsDisk`), reported in place of `dataDir`'s, which is then the
       * controller's own small volume. Null is unknown, sent as 0 of 0, which
       * Switch reads as no figure rather than a wrong one.
       */
      disk?: () => Promise<{ free: number; total: number } | null>;
      /** Where agents with no directory of their own work, reported so the server can name it. */
      workspacesDir: string;
      version: string;
      updatedBy: UpdatedBy;
      now: () => number;
      /** Told each agent's awake count from its health, for the box valve's floor. */
      onAgentAwake?: (agentId: string, awake: number) => void;
      /** Told every agent the poll read, so the box valve forgets any other's count. */
      onAgentsSeen?: (agentIds: ReadonlySet<string>) => void;
      /** The box valve's cap on awake sessions, for `sessions_max`; 0 or absent where off. */
      sessionsMax?: () => number;
      /** Isolated hosts on the hub, and how many joined the box valve; null where the valve is off. */
      valveHosts?: () => { joined: number; hosts: number } | null;
      /** The box valve's memory problem, or null when readings are fine or the valve is off. */
      valveMemory?: () => 'unprotected' | 'failing' | null;
      /** The provider gateway's counts; null where it is off. */
      gatewayCounts?: () => GatewayCounts | null;
      /** Split test boxes: operator exec into the agents container is on. */
      operatorExec?: boolean;
      /**
       * Since the controller started: agents the memory guard stopped, and
       * sessions the box valve parked. Each is null where that part is off,
       * and then left out of the report.
       */
      boxCounts?: () => BoxCounts;
      /** The memory guard: whom it holds stopped, and how often it has stopped each. */
      guard?: {
        held: (agentId: string) => string | null;
        oomKills: (agentId: string) => number;
        /** Why the box is high when no agent explains it (a code and figures), or null. */
        boxNote: () => BoxNote | null;
      };
      /** The box's `/proc/meminfo` figures, or null where there are none (`readMeminfo`). */
      meminfo?: () => Promise<MeminfoReading | null>;
    }
  ) {
    this.startedAt = new Date(deps.now()).toISOString();
  }

  /** When this collector, and so this controller process, started. */
  private readonly startedAt: string;

  /**
   * The disk to report: the agents' on a split box, marked `workspace`, else
   * the data folder's own, marked `unknown`. No reading is 0 of 0, `unknown`.
   */
  private async disk(): Promise<{ free: number; total: number; workspace: boolean }> {
    if (this.deps.disk) {
      const reading = await this.deps.disk().catch(() => null);
      return reading ? { ...reading, workspace: true } : { free: 0, total: 0, workspace: false };
    }
    const fs = await statfs(this.deps.dataDir);
    return { free: fs.bavail * fs.bsize, total: fs.blocks * fs.bsize, workspace: false };
  }

  async collect(assignment: Assignment | null): Promise<Omit<StatusReport, 'seq'>> {
    const nowMs = this.deps.now();
    const now = new Date(nowMs).toISOString();
    const agents: AgentStatus[] = [];
    let awake = 0;
    const seen = new Set<string>();
    for (const entry of assignment?.agents ?? []) {
      seen.add(entry.agent_id);
      const row = this.deps.store.agent(entry.agent_id);
      const observation = await this.deps.runtime.observe(entry.agent_id);
      const rest = this.deps.rest?.(entry.agent_id) ?? null;
      const mapped = mapAgentProcess({
        assignment: entry,
        row,
        observation,
        relayAttached: this.deps.attached(entry.agent_id),
        nowMs,
        rest,
        streamCarries: this.deps.streamCarries?.(entry.agent_id) ?? false,
        guardStop: this.deps.guard?.held(entry.agent_id) ?? null,
      });
      const standIn = restStandsIn(rest, entry, observation);
      const before = this.previous.get(entry.agent_id);
      const since =
        before && before.process === mapped.process ? before.since : (mapped.since ?? now);
      this.previous.set(entry.agent_id, { process: mapped.process, since });
      const health = observation.alive && observation.health?.current ? observation.health : null;
      // A resting agent keeps the sessions it rested with, all parked, so
      // resting changes nothing Switch reads but the agent host's processes.
      const ids = standIn
        ? [...standIn.sessions]
        : health
          ? Object.keys(health.placements).sort()
          : [];
      const session = standIn
        ? standIn.kind === 'resting'
          ? 'parked'
          : 'waking'
        : sessionStateOf(observation);
      // Resting holds nothing awake; waking counts, so the box is not stopped mid-wake.
      const agentAwake = standIn
        ? standIn.kind === 'waking'
          ? 1
          : 0
        : health
          ? awakeSessions(health, ids.length)
          : 0;
      awake += agentAwake;
      // The box valve's floor for this agent's count.
      this.deps.onAgentAwake?.(entry.agent_id, agentAwake);
      const waiting = health?.waitingForRoom;
      agents.push({
        agent_id: entry.agent_id,
        applied_revision: row?.appliedRevision ?? null,
        process: mapped.process,
        attached: mapped.attached,
        sessions: { active: ids.length, ids },
        session,
        ...(waiting && waiting.count > 0
          ? {
              waiting_for_room: { count: waiting.count, oldest_since: waiting.oldestSince },
            }
          : {}),
        restarts_10m: this.deps.store.restartsSince(entry.agent_id, nowMs - 10 * 60 * 1000),
        // Stops by the memory guard; the kernel's own kills take the whole box.
        oom_kills: this.deps.guard?.oomKills(entry.agent_id) ?? 0,
        directory: observation.configured?.cwd ?? null,
        since,
        ...(mapped.reason ? { reason: mapped.reason } : {}),
        ...(mapped.detail ? { detail: mapped.detail } : {}),
      });
    }
    for (const agentId of this.previous.keys())
      if (!seen.has(agentId)) this.previous.delete(agentId);
    this.deps.onAgentsSeen?.(seen);
    const disk = await this.disk();
    const memoryNote = this.deps.guard?.boxNote() ?? null;
    const meminfo = await (this.deps.meminfo ?? readMeminfo)();
    return {
      observed_at: now,
      controller: {
        version: this.deps.version,
        protocol: PROTOCOL_VERSION,
        assignment_revision: assignment?.revision ?? 0,
        updated_by: this.deps.updatedBy,
        started_at: this.startedAt,
      },
      machine: {
        platform: contractPlatform(),
        disk_free_bytes: disk.free,
        disk_total_bytes: disk.total,
        disk_scope: disk.workspace ? 'workspace' : 'unknown',
        mem_free_bytes: freemem(),
        mem_total_bytes: totalmem(),
        // Awake sessions only: a parked session holds no process, so counting
        // it would keep a cloud machine from ever reading as idle.
        sessions_running: awake,
        // The box valve's cap where it is on; 0 where nothing limits sessions.
        sessions_max: this.deps.sessionsMax?.() ?? 0,
        workspaces_dir: this.deps.workspacesDir,
        ...memoryNoteOf(memoryNote),
        ...valveHostsOf(this.deps.valveHosts?.() ?? null),
        ...valveMemoryOf(this.deps.valveMemory?.() ?? null),
        ...gatewayCountsOf(this.deps.gatewayCounts?.() ?? null),
        ...boxCountsOf(this.deps.boxCounts?.() ?? null),
        ...(this.deps.operatorExec ? { operator_exec: true } : {}),
        ...(meminfo ? { mem_anon_bytes: meminfo.anon, mem_cached_bytes: meminfo.cached } : {}),
      },
      providers: this.deps.providers.snapshot(),
      tools: await this.deps.tools(),
      agents,
    };
  }
}

/**
 * What decides whether a report goes out early: everything `statusFingerprint`
 * covers, plus where each agent's sessions stand (`session`: waking, active or
 * parked). Kept apart from `statusFingerprint`, which also decides when the
 * controller reconciles locally, so a session waking or parking sends a report
 * within one status poll without reconciling on every wake. Without it a wake
 * waited for the next periodic report, up to a minute (Switch once
 * showed an agent parked for 47 s after it had woken and answered).
 */
export function reportFingerprint(report: Omit<StatusReport, 'seq'>): string {
  return JSON.stringify([
    statusFingerprint(report),
    report.agents.map((a) => [a.agent_id, a.session ?? null, a.waiting_for_room?.count ?? 0]),
  ]);
}

/** Where each agent's sessions stood in a report, by agent id. */
export type SessionsSent = ReadonlyMap<string, string | null>;

export function sessionsSent(report: Pick<StatusReport, 'agents'>): SessionsSent {
  return new Map(report.agents.map((a) => [a.agent_id, a.session ?? null]));
}

/**
 * One log entry per agent whose sessions moved since the last report Switch
 * took ('active' once reached Switch about 6 s after the reply).
 * Ids, states and times only. `checkedAt` is when this report was collected;
 * `skippedAt`, when set, is a check before it that was passed over because
 * another report was on its way, the one place a change can wait a whole
 * poll after it was seen.
 */
export function sessionChangeEntries(
  before: SessionsSent | null,
  report: Pick<StatusReport, 'agents' | 'seq'>,
  times: { checkedAt: number; sentAt: number; skippedAt: number | null }
): { message: string; fields: Record<string, unknown> }[] {
  if (before === null) return [];
  return report.agents.flatMap((a) => {
    const was = before.get(a.agent_id) ?? null;
    const now = a.session ?? null;
    if (was === now) return [];
    return [
      {
        message: 'Status report carried a session change',
        fields: {
          agent_id: a.agent_id,
          seq: report.seq,
          from: was,
          to: now,
          checked_at: new Date(times.checkedAt).toISOString(),
          sent_at: new Date(times.sentAt).toISOString(),
          reason:
            times.skippedAt === null
              ? 'seen at this check'
              : 'a check was skipped while another report was on its way',
          ...(times.skippedAt === null
            ? {}
            : { skipped_at: new Date(times.skippedAt).toISOString() }),
        },
      },
    ];
  });
}

/**
 * What a report is compared on to decide whether something changed: the
 * states, not the counters and clocks that move on their own.
 */
export function statusFingerprint(report: Omit<StatusReport, 'seq'>): string {
  return JSON.stringify({
    revision: report.controller.assignment_revision,
    providers: report.providers.map((p) => [
      p.provider,
      p.installed,
      p.version,
      p.auth,
      p.reason,
      p.auth_problem,
      p.login_helps,
    ]),
    tools: report.tools.map((t) => [t.tool, t.state, t.reason]),
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
    update: report.update
      ? [report.update.target, report.update.state, report.update.problem]
      : null,
  });
}

/**
 * The test prompt for the providers that have one, run in `cwd` with this
 * process's environment: Claude Code, whose status command only says a login
 * is there.
 */
export function providerLoginTest(
  cwd: string
): (provider: Provider, binaryPath: string) => Promise<ProviderReadiness> | null {
  return (provider, binaryPath) =>
    provider === 'claude'
      ? verifyClaudeSignIn({
          binaryPath,
          cwd,
          env: Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined
            )
          ),
        })
      : null;
}

/** The guard's note for the report: a fixed code and its figures, never text; absent when there is none. */
function memoryNoteOf(note: BoxNote | null): {
  memory_note?: BoxNote['code'];
  memory_note_box_bytes?: number;
  memory_note_shmem_bytes?: number;
} {
  if (!note) return {};
  return {
    memory_note: note.code,
    memory_note_box_bytes: note.boxBytes,
    ...(note.shmemBytes === null ? {} : { memory_note_shmem_bytes: note.shmemBytes }),
  };
}

/** The box valve's memory problem, for the report: absent when there is none. */
function valveMemoryOf(problem: 'unprotected' | 'failing' | null): {
  valve_memory?: 'unprotected' | 'failing';
} {
  return problem ? { valve_memory: problem } : {};
}

/** The box valve's joined hosts, for the report: absent where the valve is off. */
function valveHostsOf(hosts: { joined: number; hosts: number } | null): {
  valve_hosts_joined?: number;
  valve_hosts?: number;
} {
  return hosts ? { valve_hosts_joined: hosts.joined, valve_hosts: hosts.hosts } : {};
}

/** Since-start counts for the box (Datadog's guard stops and valve parks); null where that part is off. */
export type BoxCounts = { guardStops: number | null; valveParks: number | null };

/** The since-start counts, for the report: each absent where its part is off. */
function boxCountsOf(counts: BoxCounts | null): { guard_stops?: number; valve_parks?: number } {
  if (!counts) return {};
  return {
    ...(counts.guardStops === null ? {} : { guard_stops: counts.guardStops }),
    ...(counts.valveParks === null ? {} : { valve_parks: counts.valveParks }),
  };
}

/** The provider gateway's counts; `callsToday` and `capped` only where a daily cap is set. */
export type GatewayCounts = {
  agents: number;
  refused: number;
  callsToday?: number;
  capped?: boolean;
};

/** The provider gateway's counts, for the report: absent where it is off. */
function gatewayCountsOf(counts: GatewayCounts | null): {
  gateway_agents?: number;
  gateway_refused?: number;
  gateway_calls_today?: number;
  gateway_capped?: boolean;
} {
  if (!counts) return {};
  return {
    gateway_agents: counts.agents,
    gateway_refused: counts.refused,
    ...(counts.callsToday === undefined ? {} : { gateway_calls_today: counts.callsToday }),
    ...(counts.capped === undefined ? {} : { gateway_capped: counts.capped }),
  };
}
