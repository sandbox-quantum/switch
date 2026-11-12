import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CONTROL_FILE,
  clearTakenOver,
  type SharedHostConfig,
  WATCH_FLAGS_FILE,
  WATCHER_HEALTH_FILE,
  type WatchFlags,
  watcherHealthFileSchema,
  watchFlagsSchema,
} from '@switch-console/agent-providers-box';
import type { MarkerTable, OwnerMarkers } from './owner-marker';
import type { DataLayout } from './paths';
import {
  type AgentObservation,
  type AgentRunner,
  LaunchedBundle,
  type LaunchOptions,
  ownsRoot,
  OWNER_RECORDS,
  readOptional,
  readRoot,
  recordedPid,
  removeOptional,
  STOP_TIMEOUT_MS,
  writeAtomic,
} from './runtime';

const LAUNCH_TIMEOUT_MS = 60_000;

/**
 * Runs each isolated agent's host as a process of its own, as Switch Console
 * runs an agent on an SSH host: a detached agent host from the agent-providers
 * shared-host bundle, in a state root of its own, driven through the files it
 * reads (`watch.json`, `config.json`) and observed through the files it
 * writes (`health.json`, `supervisor/failure.json`). It makes its calls to
 * Switch through the controller's relay, and hears its events on the
 * controller's hub, over a WebSocket on the relay's port.
 *
 * Being its own process, it is not stopped when the controller exits: it
 * keeps retrying the hub, and picks up again when the controller is back,
 * still on the bundle it was started from. One on another bundle than this
 * controller's is `outdated`, and the controller restarts it once idle.
 * A restart is a stop and a start: the agent host is turned off, waited out,
 * and launched again from the new template.
 */
export class DetachedRuntime implements AgentRunner {
  private readonly bundle: LaunchedBundle;

  constructor(
    private readonly deps: {
      layout: DataLayout;
      /** The `shared-host-daemon.mjs` bundle from agent-providers. */
      bundlePath: string;
      /**
       * Marks everything an agent's host starts as that agent's, for the
       * memory guard and resting agents to stop with proof (`owner-marker.ts`).
       */
      ownerMarkers?: Pick<OwnerMarkers | MarkerTable, 'environmentFor'>;
      /**
       * Starts the host from its written template in place of the bundle's
       * `--ensure-watch`. A split box's launcher does it in its own process, so the
       * host is its child and its pid is known from the spawn.
       */
      start?: (agentId: string, root: string, templatePath: string) => Promise<void>;
    }
  ) {
    this.bundle = new LaunchedBundle(deps.bundlePath);
  }

  /** Whether a host of this agent's recorded processes is alive and owns its root. */
  private async living(root: string): Promise<boolean> {
    let living = false;
    for (const record of OWNER_RECORDS) {
      const pid = await recordedPid(join(root, record));
      if (pid !== null && pid !== process.pid && (await ownsRoot(pid, root))) living = true;
    }
    return living;
  }

  async observe(agentId: string): Promise<AgentObservation> {
    const root = this.deps.layout.watcherRoot(agentId);
    const living = await this.living(root);
    const healthText = await readOptional(join(root, WATCHER_HEALTH_FILE));
    let health: AgentObservation['health'] = null;
    if (healthText !== null) {
      const parsed = watcherHealthFileSchema.parse(JSON.parse(healthText));
      health = {
        ...parsed,
        current: parsed.pid !== process.pid && (await ownsRoot(parsed.pid, root)),
      };
    }
    return {
      ...(await readRoot(root)),
      alive: living,
      health,
      outdated: living && (await this.bundle.outdates(health)),
    };
  }

  async launch(agentId: string, template: SharedHostConfig, options: LaunchOptions): Promise<void> {
    const root = this.deps.layout.watcherRoot(agentId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (options.restart || options.replaceIdentity) await this.stop(agentId, { wait: true });
    if (options.replaceIdentity) await removeOptional(join(root, 'config.json'));
    if (options.clearTakenOver) await clearTakenOver(root);
    // A host that ended without stopping cleanly (its box slept and the pod was
    // killed) leaves its control.json, naming a port that is no longer its.
    // The launcher would end every new host on its first ticket hand-over
    // (`wrong_port`), so with no host of this agent alive, the file is stale
    // and goes. A live host's own file is never touched (1 Nov defect).
    if (!(await this.living(root))) await removeOptional(join(root, CONTROL_FILE));
    await this.writeFlags(root, { enabled: true, spawn: true });
    const templatePath = join(root, 'template.json');
    await writeAtomic(templatePath, JSON.stringify(template));
    if (this.deps.start) return this.deps.start(agentId, root, templatePath);
    await this.runBundle(
      [root, templatePath, '--ensure-watch', 'false'],
      LAUNCH_TIMEOUT_MS,
      this.deps.ownerMarkers?.environmentFor(agentId) ?? {}
    );
  }

  /** `asked` is not needed here: its worker closes its sessions unasked, so cut-off turns owe their line. */
  async stop(agentId: string, options: { wait: boolean; asked?: boolean }): Promise<void> {
    const root = this.deps.layout.watcherRoot(agentId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await this.writeFlags(root, { enabled: false, spawn: false });
    if (!options.wait) return;
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    for (;;) {
      let running = false;
      for (const record of OWNER_RECORDS) {
        const pid = await recordedPid(join(root, record));
        if (pid !== null && pid !== process.pid && (await ownsRoot(pid, root))) running = true;
      }
      if (!running) return;
      if (Date.now() > deadline)
        throw new Error(
          `The agent host for agent ${agentId} has not stopped ${STOP_TIMEOUT_MS / 1000} s after being turned off; see ${join(root, 'supervisor', 'worker.log')}.`
        );
      await delay(200);
    }
  }

  /** Isolated agent hosts outlive the controller; nothing to stop. */
  async close(): Promise<void> {}

  private async writeFlags(root: string, flags: WatchFlags): Promise<void> {
    await writeAtomic(join(root, WATCH_FLAGS_FILE), JSON.stringify(watchFlagsSchema.parse(flags)));
  }

  /**
   * Runs the bundle with this process's environment and `extraEnv`: the
   * supervisor it starts, and everything after, inherit both. The controller's
   * own environment is left as it is.
   */
  private async runBundle(
    args: string[],
    timeoutMs: number,
    extraEnv: Record<string, string>
  ): Promise<string> {
    const child = spawn(process.execPath, [this.deps.bundlePath, ...args], {
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (exitCode) => resolve(exitCode));
      });
      if (code !== 0)
        throw new Error(
          `The shared host launcher failed (exit ${code ?? 'signal'}): ${(stderr || stdout).trim().slice(-2000)}`
        );
      return stdout;
    } finally {
      clearTimeout(timer);
    }
  }
}
