/**
 * Checks this computer's providers as onboarding opens, before it is enrolled
 * as a machine anywhere, with the controller's own `precheck`: the same
 * checks its controller runs, on the same binary and environment. The
 * controller started later takes the results (`--provider-seed`), so its
 * first report already says what is signed in, rather than checking from
 * scratch once enrolled.
 */
export type ProviderPrecheckDeps = {
  execPath: string;
  bundles: { controller: () => string; sharedHost: () => string };
  env: () => NodeJS.ProcessEnv;
  /** Where the results go, written as each check comes back. */
  seedFile: () => string;
  /** Where the checks run, and the CLIs keep what they write when asked their version. */
  probeDir: () => string;
  /** Runs the check to its end; rejects, saying why, when it fails. */
  execute: (executable: string, args: string[], env: NodeJS.ProcessEnv) => Promise<void>;
  log: { warn: (message: string, fields?: Record<string, unknown>) => void };
  /** The file's text, or null when there is none yet. */
  read: (file: string) => Promise<string | null>;
  now: () => number;
};

/** A provider as the precheck found it, in the terms a controller reports it to Switch. */
export type PrecheckedProvider = {
  provider: string;
  installed: boolean;
  auth: 'ok' | 'expired' | 'missing' | 'unknown';
};

/** A check older than this is made again when asked; the controller takes none older either. */
const FRESH_MS = 10 * 60 * 1000;

export class ProviderPrecheck {
  private running: Promise<void> | null = null;
  private startedAt: number | null = null;

  constructor(private readonly deps: ProviderPrecheckDeps) {}

  /** Starts the checks, unless they are running or ran a short while ago. */
  start(): void {
    if (this.running) return;
    if (this.startedAt !== null && this.deps.now() - this.startedAt < FRESH_MS) return;
    this.startedAt = this.deps.now();
    this.running = this.deps
      .execute(
        this.deps.execPath,
        [
          this.deps.bundles.controller(),
          'precheck',
          '--out',
          this.deps.seedFile(),
          '--probe-dir',
          this.deps.probeDir(),
          '--shared-host-bundle',
          this.deps.bundles.sharedHost(),
        ],
        { ...this.deps.env(), ELECTRON_RUN_AS_NODE: '1', SWITCH_CONTROLLER_LOG_LEVEL: 'warn' }
      )
      .catch((error: unknown) => {
        // The controller checks every provider itself, as it did before.
        this.deps.log.warn('Could not check the providers ahead of the controller', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.running = null;
      });
  }

  /**
   * The file of checks for a controller starting now, or null when none were
   * started in this session. Results still coming in are fine: the controller
   * takes those already written and checks the rest itself.
   */
  seedFile(): string | null {
    return this.startedAt === null ? null : this.deps.seedFile();
  }

  /**
   * What the checks started in this session have found so far, still fresh;
   * null when none were started. For a page that cannot wait for this
   * computer's controller to report.
   */
  async results(): Promise<PrecheckedProvider[] | null> {
    if (this.startedAt === null) return null;
    const text = await this.deps.read(this.deps.seedFile());
    if (text === null) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      this.deps.log.warn('The provider checks made ahead of the controller are not readable', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
    const entries = (parsed as { providers?: unknown }).providers;
    if (!Array.isArray(entries)) return [];
    return entries.flatMap((entry): PrecheckedProvider[] => {
      const status = (entry as { status?: Record<string, unknown> }).status;
      if (!status) return [];
      const { provider, installed, auth, checked_at: checkedAt } = status;
      if (
        typeof provider !== 'string' ||
        typeof installed !== 'boolean' ||
        (auth !== 'ok' && auth !== 'expired' && auth !== 'missing' && auth !== 'unknown') ||
        typeof checkedAt !== 'string'
      )
        return [];
      // Checked before this session's start: a file left from an earlier one.
      const at = Date.parse(checkedAt);
      if (!(at >= this.startedAt! - 1000) || this.deps.now() - at >= FRESH_MS) return [];
      return [{ provider, installed, auth }];
    });
  }
}
