import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  clearTakenOver,
  type SharedHostConfig,
  WATCH_FLAGS_FILE,
  WATCHER_HEALTH_FILE,
  type WatchFlags,
  watcherHealthFileSchema,
  watchFlagsSchema,
} from '@switch-console/agent-providers';
import type { DataLayout } from './paths';
import {
  type AgentObservation,
  type AgentRunner,
  assertSupportedPlatform,
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
 * keeps retrying the hub, and picks up again when the controller is back.
 * A restart is a stop and a start: the agent host is turned off, waited out,
 * and launched again from the new template.
 */
export class DetachedRuntime implements AgentRunner {
  constructor(
    private readonly deps: {
      layout: DataLayout;
      /** The `shared-host-daemon.mjs` bundle from agent-providers. */
      bundlePath: string;
    }
  ) {
    assertSupportedPlatform(process.platform);
  }

  async observe(agentId: string): Promise<AgentObservation> {
    const root = this.deps.layout.watcherRoot(agentId);
    let living = false;
    for (const record of OWNER_RECORDS) {
      const pid = await recordedPid(join(root, record));
      if (pid !== null && pid !== process.pid && (await ownsRoot(pid, root))) living = true;
    }
    const healthText = await readOptional(join(root, WATCHER_HEALTH_FILE));
    let health: AgentObservation['health'] = null;
    if (healthText !== null) {
      const parsed = watcherHealthFileSchema.parse(JSON.parse(healthText));
      health = {
        ...parsed,
        current: parsed.pid !== process.pid && (await ownsRoot(parsed.pid, root)),
      };
    }
    return { ...(await readRoot(root)), alive: living, health };
  }

  async launch(agentId: string, template: SharedHostConfig, options: LaunchOptions): Promise<void> {
    const root = this.deps.layout.watcherRoot(agentId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (options.restart || options.replaceIdentity) await this.stop(agentId, { wait: true });
    if (options.replaceIdentity) await removeOptional(join(root, 'config.json'));
    if (options.clearTakenOver) await clearTakenOver(root);
    await this.writeFlags(root, { enabled: true, spawn: true });
    const templatePath = join(root, 'template.json');
    await writeAtomic(templatePath, JSON.stringify(template));
    await this.runBundle([root, templatePath, '--ensure-watch', 'false'], LAUNCH_TIMEOUT_MS);
  }

  async stop(agentId: string, options: { wait: boolean }): Promise<void> {
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

  private async runBundle(args: string[], timeoutMs: number): Promise<string> {
    const child = spawn(process.execPath, [this.deps.bundlePath, ...args], {
      env: process.env,
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
