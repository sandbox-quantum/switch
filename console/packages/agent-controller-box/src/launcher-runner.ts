import {
  type SharedHostConfig,
  watcherHealthFileSchema,
} from '@switch-console/agent-providers-box';
import { z } from 'zod';
import type { HostTickets } from './host-tickets';
import type { LauncherLink } from './launcher-link';
import type { HostFailure, ReplyCode } from './launcher-protocol';
import type { OwnerMarkers } from './owner-marker';
import type { AgentObservation, AgentRunner, LaunchOptions, RelayCredentials } from './runtime';

/**
 * Runs agent hosts through the launcher, in place of
 * `DetachedRuntime`, behind the same `AgentRunner` seam: the controller orders,
 * the launcher in the agents container does. Every launch gets a fresh launch
 * id, a marker for that launch alone, and a one-time ticket the host must
 * present at its hub `hello` (C2, C8, C9). The controller's credential, the
 * gateway token and the marker key never cross.
 */
/**
 * Variables that can carry a credential. On a split box a login must never
 * reach the agents container: logins come through the provider gateway. So
 * for each of these, a launch allows only an empty value (how a login is
 * cleared) or one of the gateway's own per-agent tokens (`swpg_…`), and
 * refuses anything else before anything is ordered.
 */
export const CREDENTIAL_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CURSOR_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_ACCESS_TOKEN',
  'AZURE_OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
] as const;

/** Any other name that looks like it carries a secret is held to the same rule. */
const CREDENTIAL_NAME =
  /^AWS_|(^|_)(API_KEY|AUTH_TOKEN|OAUTH_TOKEN|ACCESS_TOKEN|SECRET|SECRET_KEY|PASSWORD|CREDENTIALS|PRIVATE_KEY|SESSION_TOKEN)$/;
const GATEWAY_TOKEN = /^swpg_[A-Za-z0-9_-]{16,256}$/;

/** The credential-carrying variables in `env` whose value is neither empty nor a gateway token. */
export function credentialsCrossing(env: Record<string, string>): string[] {
  return Object.entries(env)
    .filter(
      ([name, value]) =>
        ((CREDENTIAL_ENV_KEYS as readonly string[]).includes(name) || CREDENTIAL_NAME.test(name)) &&
        value !== '' &&
        !GATEWAY_TOKEN.test(value)
    )
    .map(([name]) => name)
    .sort();
}

/** What the controller takes from an `observe` reply: these fields and nothing else. */
const observationSchema = z
  .object({
    alive: z.boolean(),
    health: z.unknown().nullable(),
    // Any string is read, but only a known code is believed; anything else is `other`.
    failure: z.string().max(64).nullable(),
    outdated: z.boolean(),
  })
  .strict();
/**
 * The status line for each reason a host isn't running: fixed words of the
 * controller's own, never text from the launcher. The
 * credentials line keeps the words `isCredentialFailure` looks for.
 */
const FAILURE_LINES: Record<HostFailure | ReplyCode | 'bad_observation', string> = {
  credentials_rejected: 'Switch rejected the agent credentials.',
  provider_missing: 'The provider’s CLI was not found in the agents container.',
  host_failed:
    'The agent host stopped with a failure; its worker log in the agents container says why.',
  other: 'The agent host reported a failure.',
  bad_template: 'The launcher refused the agent’s configuration.',
  bad_directory: 'The agent’s working directory is outside the agents’ folders.',
  unknown_agent: 'The launcher has not started this agent.',
  failed: 'The launcher could not answer for this agent.',
  launcher_lost: 'The launcher in the agents container is not connected.',
  timed_out: 'The launcher did not answer in time.',
  // The file explorer's refusals: never about a host, but every reply code has a line.
  outside_root: 'The launcher refused a file request outside the workspaces.',
  denied: 'The launcher refused a file request for something never readable.',
  not_found: 'The launcher found nothing at a requested file path.',
  too_large: 'A requested file or folder was over the size limit.',
  not_regular: 'A requested path was not a regular file or folder.',
  busy: 'The launcher had too many file requests at once.',
  bad_observation: 'The launcher’s answer about this agent could not be read.',
};

/** A failure code from the launcher, as the status line to show; an unknown code is `other`. */
export function failureLine(code: string): string {
  return FAILURE_LINES[(code in FAILURE_LINES ? code : 'other') as keyof typeof FAILURE_LINES];
}

const healthSchema = watcherHealthFileSchema.extend({ current: z.boolean() }).strict();

export class LauncherRunner implements AgentRunner {
  /**
   * Launch ids go up from the controller's clock at start, so one from before
   * a controller restart is never handed out again.
   */
  private nextLaunch: number;
  private readonly launches = new Map<string, number>();
  /** A launch ordered and not yet answered: its host may say hello before the reply arrives. */
  private readonly pending = new Map<string, number>();

  constructor(
    private readonly deps: {
      link: Pick<LauncherLink, 'order'>;
      tickets: HostTickets;
      markers: Pick<OwnerMarkers, 'markerForLaunch'>;
      /** The agent's relay credentials, as the controller issued them. */
      credentials: (agentId: string) => RelayCredentials | null;
      now?: () => number;
    }
  ) {
    this.nextLaunch = (deps.now ?? Date.now)();
  }

  /** The launch the agent's current host was started as, or null. */
  launchOf(agentId: string): number | null {
    return this.launches.get(agentId) ?? null;
  }

  /**
   * The launch a ticket must belong to, for the hub to take it: the one being
   * ordered, else the current one.
   */
  currentLaunch(agentId: string): number | null {
    return this.pending.get(agentId) ?? this.launches.get(agentId) ?? null;
  }

  async launch(agentId: string, template: SharedHostConfig, options: LaunchOptions): Promise<void> {
    const credentials = this.deps.credentials(agentId);
    if (!credentials) throw new Error('The agent has no relay credentials to launch with.');
    const crossing = credentialsCrossing(template.start.input.env ?? {});
    if (crossing.length > 0)
      throw new Error(
        `Not launching: the agent’s start carries a credential (${crossing.join(', ')}), which never goes to the agents container on this box. Logins reach agents through the provider gateway.`
      );
    const launchId = this.nextLaunch++;
    this.pending.set(agentId, launchId);
    const reply = await this.deps.link.order({
      kind: 'launch',
      agentId,
      launchId,
      template: template as unknown as Record<string, unknown>,
      marker: this.deps.markers.markerForLaunch(agentId, launchId),
      ticket: this.deps.tickets.mint(agentId, launchId),
      // The relay token and hub only: logins come through the credential gateway.
      credentials: {
        endpoint: credentials.endpoint,
        token: credentials.token,
        hub: credentials.hub,
      },
      // Made there when inside the workspaces folder, as a host here would have it made.
      directory: template.start.input.cwd,
      restart: options.restart,
      replaceIdentity: options.replaceIdentity,
      clearTakenOver: options.clearTakenOver,
    });
    if (this.pending.get(agentId) === launchId) this.pending.delete(agentId);
    if (!reply.ok) {
      this.deps.tickets.forget(agentId);
      throw new Error(`The launcher did not start the agent host (${reply.code ?? 'failed'}).`);
    }
    this.launches.set(agentId, launchId);
  }

  async stop(agentId: string, options: { wait: boolean; asked?: boolean }): Promise<void> {
    this.deps.tickets.forget(agentId);
    this.pending.delete(agentId);
    const reply = await this.deps.link.order({
      kind: 'stop',
      agentId,
      wait: options.wait,
      asked: options.asked ?? true,
    });
    this.launches.delete(agentId);
    if (!reply.ok)
      throw new Error(`The launcher did not stop the agent host (${reply.code ?? 'failed'}).`);
  }

  async observe(agentId: string): Promise<AgentObservation> {
    const reply = await this.deps.link.order({ kind: 'observe', agentId });
    const none = (failure: string): AgentObservation => ({
      alive: false,
      configured: null,
      flags: null,
      health: null,
      failure,
      takenOver: null,
      outdated: false,
    });
    // Not answered (the launcher lost or slow): said by its fixed code.
    if (!reply.ok) return none(failureLine(reply.code ?? 'failed'));
    // Untrusted: exactly these fields, each checked; anything else and it counts as not seen.
    const seen = observationSchema.safeParse(reply.observation);
    if (!seen.success) return none(failureLine('bad_observation'));
    const health = seen.data.health === null ? null : healthSchema.safeParse(seen.data.health);
    return {
      alive: seen.data.alive,
      configured: null,
      flags: null,
      health: health?.success ? health.data : null,
      failure: seen.data.failure === null ? null : failureLine(seen.data.failure),
      takenOver: null,
      outdated: seen.data.outdated,
    };
  }

  async close(): Promise<void> {}
}
