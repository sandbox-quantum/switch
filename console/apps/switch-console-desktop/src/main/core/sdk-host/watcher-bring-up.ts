import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import { SshFileSystem } from '@main/core/fs/impl/ssh-fs';
import type { LocationTransport } from '@main/core/locations/location-transport';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import { ensureHostBundle, forgetHostBundle } from './host-bundle';
import { legacySidecarSlug, STOP_LEGACY_SIDECAR_FN } from './legacy-sidecar';
import { WATCHER_ROOT } from './state-roots';
import { WAIT_FOR_WATCHER_STOP_FN } from './watcher-inspection';

/** Where the auto-approve choice a Console made is kept, beside the watcher. */
export const AUTO_APPROVE_CHOICE_FILE = 'auto-approve.json';

/**
 * Brings one agent's watcher on its host to the state asked for, in one
 * command. Takes one argument, the JSON of `BringUpOptions`, and prints the
 * JSON of `BringUpResult`.
 *
 * In order: find the watcher's state root; stop a sidecar an earlier Console
 * deployed for the agent, if one is still there; write the watch flags,
 * clearing a takeover marker when asked; then either wait for a watcher that
 * is being stopped to go, or launch it from the configuration staged for it —
 * taking the auto-approve choice kept on the host first, when asked, since
 * another Console on the account may have set it. The staged configuration is
 * removed whatever happens, since it holds the agent's credentials.
 *
 * These used to be eight separate SSH commands, each its own round trip and
 * its own chance to be cut off halfway. They are all small operations in one
 * directory tree on one machine, so they are one.
 */
export const BRING_UP_SCRIPT = String.raw`${WATCHER_ROOT}${STOP_LEGACY_SIDECAR_FN}${WAIT_FOR_WATCHER_STOP_FN}
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const cp = require('node:child_process');
const o = JSON.parse(process.argv[1]);
const put = (file, data) => {
  const tmp = file + '.' + crypto.randomUUID();
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
};
const out = { root: null, runtimeMode: null, legacyStopped: [] };
try {
  const base = path.join(require('node:os').homedir(), '.local', 'state', 'switch', 'sdk-watchers');
  const root = watcherRoot(base, o.identity);
  out.root = root;
  out.legacyStopped = stopLegacySidecar(o.repoDir, o.slug);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (o.clear)
    try { fs.unlinkSync(path.join(root, 'taken-over.json')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  put(path.join(root, 'watch.json'), { enabled: o.enabled, spawn: o.spawn });
  if (!o.enabled) waitForWatcherStop(root);
  else {
    const configPath = path.join(o.staging, 'config.json');
    fs.chmodSync(configPath, 0o600);
    if (o.adoptAutoApprove) {
      let chosen = null;
      try {
        chosen = JSON.parse(fs.readFileSync(path.join(root, '${AUTO_APPROVE_CHOICE_FILE}'), 'utf8'))?.runtimeMode ?? null;
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if ((chosen === 'full-access' || chosen === 'approval-required') && chosen !== config.start.input.runtimeMode) {
        config.start.input.runtimeMode = chosen;
        put(configPath, config);
        out.runtimeMode = chosen;
      }
    }
    const launched = cp.spawnSync(
      process.execPath,
      [o.entrypoint, root, configPath, '--ensure-watch', 'false'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
    );
    if (launched.error) throw launched.error;
    if (launched.status !== 0)
      throw new Error('The shared host launcher failed (exit ' + launched.status + '): ' +
        String(launched.stderr || launched.stdout || '').trim().slice(-2000));
  }
} finally {
  if (o.staging) fs.rmSync(o.staging, { recursive: true, force: true });
}
console.log(JSON.stringify(out));
`;

export type BringUpOptions = {
  /** The Switch agent id the watcher runs as. */
  identity: string;
  /** The agent's working directory, and its name there, for an earlier sidecar. */
  repoDir: string;
  slug: string;
  enabled: boolean;
  spawn: boolean;
  /** Remove a takeover marker: an explicit start, or any stop. */
  clear: boolean;
  /** Take the auto-approve choice kept on the host into the staged configuration. */
  adoptAutoApprove: boolean;
  entrypoint: string;
  /** The directory the configuration is staged in, or null when stopping. */
  staging: string | null;
};

const resultSchema = z.object({
  root: z.string(),
  runtimeMode: z.enum(['full-access', 'approval-required']).nullable(),
  legacyStopped: z.array(z.string()),
});

export type BringUpResult = z.infer<typeof resultSchema>;

/**
 * Bring an agent's watcher on an SSH host to `state`, in two round trips at
 * most: the configuration staged over SFTP (only when connecting), then
 * `BRING_UP_SCRIPT`. The host's bundle is checked once per host, not here
 * (`ensureHostBundle`); a bring-up that fails forgets that check, since a
 * bundle that has gone is one reason it might.
 */
export async function bringUpRemoteWatcher(input: {
  transport: Extract<LocationTransport, { kind: 'ssh' }>;
  repoDir: string;
  identity: string;
  credentialsPath: string;
  state: { connected: boolean; spawning: boolean };
  clear: boolean;
  adoptAutoApprove: boolean;
  config: unknown;
}): Promise<BringUpResult> {
  const { transport } = input;
  try {
    const bundle = await ensureHostBundle(transport);
    const proxy = await ensureSshConnected(transport.connectionId, transport.host);
    let staging: string | null = null;
    if (input.state.connected) {
      const name = `launch-${randomUUID()}`;
      const local = await mkdtemp(join(tmpdir(), 'switch-sdk-launch-'));
      const fs = new SshFileSystem(proxy, bundle.staging);
      try {
        await writeFile(join(local, 'config.json'), JSON.stringify(input.config), { mode: 0o600 });
        await fs.mkdir(name);
        await fs.copyLocalFile(join(local, 'config.json'), `${name}/config.json`);
      } finally {
        fs.close();
        await rm(local, { recursive: true, force: true });
      }
      staging = `${bundle.staging}/${name}`;
    }
    const options: BringUpOptions = {
      identity: input.identity,
      repoDir: input.repoDir,
      slug: legacySidecarSlug(input.credentialsPath),
      enabled: input.state.connected,
      spawn: input.state.spawning,
      clear: input.clear,
      adoptAutoApprove: input.adoptAutoApprove,
      entrypoint: bundle.entrypoint,
      staging,
    };
    const ctx = new SshExecutionContext(proxy, { root: input.repoDir });
    const { stdout } = await ctx.exec('node', ['-e', BRING_UP_SCRIPT, JSON.stringify(options)]);
    return resultSchema.parse(JSON.parse(stdout.trim()));
  } catch (error) {
    forgetHostBundle(transport.connectionId);
    throw error;
  }
}
