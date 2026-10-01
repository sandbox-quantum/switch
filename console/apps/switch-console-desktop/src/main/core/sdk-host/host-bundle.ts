import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolveSharedHostBundlePath } from '@main/core/agent-runtime/impl/resolve-sidecar-bundle';
import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import { SshFileSystem } from '@main/core/fs/impl/ssh-fs';
import type { LocationTransport } from '@main/core/locations/location-transport';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import { STALE_LAUNCH_MS } from './state-roots';

/**
 * Readies a host for this build's shared host, and prints what the caller
 * needs as JSON: the bundle's directory, whether this build's bundle is
 * already there, and where launches stage their configuration.
 *
 * Everything a host needs once rather than once per agent, in one command:
 * the directories exist, bundles no running process names are removed (every
 * deployment leaves one named after its own hash, so an upgraded host would
 * otherwise keep one per build it ever ran), and staged configurations older
 * than `STALE_LAUNCH_MS` are removed, since each holds an agent's credentials
 * and a launch whose connection dropped leaves its own behind.
 *
 * Arguments: this build's bundle file name, its SHA-256, and the staleness
 * threshold in milliseconds.
 */
export const HOST_PREPARE = String.raw`
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const [wanted, hash, staleArg] = process.argv.slice(1);
const state = path.join(require('node:os').homedir(), '.local', 'state', 'switch');
const directory = path.join(state, 'sdk-host');
const staging = path.join(state, 'sdk-launch');
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
let present = false;
try {
  present = crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, wanted))).digest('hex') === hash;
} catch (e) { if (e.code !== 'ENOENT') throw e; }
const running = require('node:child_process').execFileSync('ps', ['-eo', 'args='], { encoding: 'utf8' });
for (const name of fs.readdirSync(directory)) {
  if (name === wanted || running.includes(name)) continue;
  if (/^shared-host-[a-f0-9]{64}\.mjs$/.test(name) || /^shared-host-[a-f0-9]{64}\.[0-9a-f-]+\.tmp$/.test(name))
    fs.rmSync(path.join(directory, name), { force: true });
}
const cutoff = Date.now() - Number(staleArg);
const sweep = (dir, abandoned) => {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for (const name of names) {
    if (!abandoned(name)) continue;
    const entry = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(entry); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (stat.mtimeMs < cutoff) fs.rmSync(entry, { recursive: true, force: true });
  }
};
sweep(staging, () => true);
for (const kind of ['sdk-watchers', 'sdk-sessions'])
  sweep(path.join(state, kind), (name) => name.startsWith('.launch-') || name.startsWith('launch-'));
console.log(JSON.stringify({ directory, staging, present }));
`;

export type HostBundle = {
  /** This build's shared host entrypoint on the host. */
  entrypoint: string;
  /** Where a launch stages its configuration on the host. */
  staging: string;
};

/**
 * How long a host is taken to still have this build's bundle once checked.
 * Another Console on the same account, on another build, prunes bundles no
 * running process names, so the answer does not hold for ever.
 */
export const HOST_BUNDLE_TTL_MS = 10 * 60 * 1000;

const prepared = new Map<string, { at: number; hash: string; bundle: Promise<HostBundle> }>();

/** Forget what was learned about a host, so the next launch checks it again. */
export function forgetHostBundle(connectionId: string): void {
  prepared.delete(connectionId);
}

/** Forget every host. For tests. */
export function clearHostBundles(): void {
  prepared.clear();
}

/**
 * This build's shared host bundle on an SSH host, uploaded if it is not there.
 *
 * Once per host, not once per agent: every agent on a host runs the same
 * file, so checking it for each of twenty agents asked the same question
 * twenty times, at half a dozen round trips each. Callers on the same host
 * share one check — the one in flight, or its answer for
 * `HOST_BUNDLE_TTL_MS` — and a launch that fails forgets it
 * (`forgetHostBundle`), since a missing bundle is one reason it might.
 */
export async function ensureHostBundle(
  transport: Extract<LocationTransport, { kind: 'ssh' }>
): Promise<HostBundle> {
  const local = resolveSharedHostBundlePath();
  const hash = createHash('sha256')
    .update(await readFile(local))
    .digest('hex');
  const cached = prepared.get(transport.connectionId);
  if (cached && cached.hash === hash && Date.now() - cached.at < HOST_BUNDLE_TTL_MS)
    return cached.bundle;
  const bundle = prepare(transport, local, hash);
  prepared.set(transport.connectionId, { at: Date.now(), hash, bundle });
  bundle.catch(() => {
    if (prepared.get(transport.connectionId)?.bundle === bundle)
      prepared.delete(transport.connectionId);
  });
  return bundle;
}

async function prepare(
  transport: Extract<LocationTransport, { kind: 'ssh' }>,
  local: string,
  hash: string
): Promise<HostBundle> {
  const proxy = await ensureSshConnected(transport.connectionId, transport.host);
  const ctx = new SshExecutionContext(proxy, { root: transport.dir });
  const name = `shared-host-${hash}.mjs`;
  const { stdout } = await ctx.exec('node', [
    '-e',
    HOST_PREPARE,
    name,
    hash,
    String(STALE_LAUNCH_MS),
  ]);
  const host = JSON.parse(stdout.trim()) as {
    directory: string;
    staging: string;
    present: boolean;
  };
  const entrypoint = `${host.directory}/${name}`;
  if (!host.present) {
    // Uploaded under a temporary name and renamed into place, so a process
    // starting from it never reads half a file.
    const temporary = `shared-host-${hash}.${randomUUID()}.tmp`;
    const fs = new SshFileSystem(proxy, host.directory);
    try {
      await fs.copyLocalFile(local, temporary);
    } finally {
      fs.close();
    }
    await ctx.exec('node', [
      '-e',
      "require('node:fs').renameSync(process.argv[1],process.argv[2])",
      `${host.directory}/${temporary}`,
      entrypoint,
    ]);
  }
  return { entrypoint, staging: host.staging };
}
