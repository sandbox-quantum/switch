import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSharedHostBundlePath } from '@main/core/agent-runtime/impl/resolve-sidecar-bundle';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { SshFileSystem } from '@main/core/fs/impl/ssh-fs';
import type { LocationTransport } from '@main/core/locations/location-transport';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import { ensureHostBundle } from './host-bundle';
import { MAKE_LAUNCH_DIR, RESOLVE_STATE_ROOT, STALE_LAUNCH_MS } from './state-roots';

/**
 * Prints the path of a shared host bundle already on the host: this build's
 * when it is there, otherwise the newest one an earlier deployment left, and
 * nothing when there is none. Arguments: this build's bundle file name.
 */
export const LOCATE_BUNDLE = String.raw`
const fs = require('node:fs'), path = require('node:path');
const [wanted] = process.argv.slice(1);
const dir = path.join(require('node:os').homedir(), '.local', 'state', 'switch', 'sdk-host');
let names;
try { names = fs.readdirSync(dir); }
catch (e) { if (e.code === 'ENOENT') { console.log(''); process.exit(0); } throw e; }
const bundles = names.filter((name) => /^shared-host-[a-f0-9]{64}\.mjs$/.test(name));
if (bundles.includes(wanted)) console.log(path.join(dir, wanted));
else if (!bundles.length) console.log('');
else console.log(path.join(dir, bundles
  .map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
  .sort((a, b) => b.at - a.at)[0].name));
`;

/**
 * A shared host to run a one-off command with, without deploying one: this
 * machine's own bundle, or a bundle already on the SSH host. Reading a host —
 * what its provider offers, whether it is signed in — must not change what is
 * installed there; only a launch, or somebody pressing Update, deploys. Null
 * when the host has no bundle yet.
 */
export async function locateSharedHost(
  transport: LocationTransport,
  dir: string
): Promise<{ ctx: IExecutionContext; entrypoint: string } | null> {
  const bundle = resolveSharedHostBundlePath();
  if (transport.kind !== 'ssh') return { ctx: new LocalExecutionContext(), entrypoint: bundle };
  const hash = createHash('sha256')
    .update(await readFile(bundle))
    .digest('hex');
  const proxy = await ensureSshConnected(transport.connectionId, transport.host);
  const ctx = new SshExecutionContext(proxy, { root: dir });
  const { stdout } = await ctx.exec('node', ['-e', LOCATE_BUNDLE, `shared-host-${hash}.mjs`]);
  const entrypoint = stdout.trim();
  if (entrypoint) return { ctx, entrypoint };
  ctx.dispose();
  return null;
}

export async function deploySharedHost(
  transport: LocationTransport,
  sessionPath: string,
  identity: string,
  watcher: boolean
) {
  let ctx: IExecutionContext;
  const key = createHash('sha256').update(identity).digest('hex');
  let entrypoint = resolveSharedHostBundlePath();
  if (transport.kind === 'ssh') {
    // Checked, and uploaded if missing, once per host rather than per agent.
    entrypoint = (await ensureHostBundle(transport)).entrypoint;
    const proxy = await ensureSshConnected(transport.connectionId, transport.host);
    ctx = new SshExecutionContext(proxy, { root: sessionPath });
  } else ctx = new LocalExecutionContext();
  const { stdout } = await ctx.exec('node', [
    '-e',
    RESOLVE_STATE_ROOT,
    key,
    watcher ? 'sdk-watchers' : 'sdk-sessions',
    identity,
  ]);
  const root = stdout.trim();
  return { ctx, root, entrypoint };
}

/** The state root of `identity`'s watcher on an SSH host, and a context to act
 * in it, without deploying the host bundle. */
export async function resolveWatcherRoot(
  transport: Extract<LocationTransport, { kind: 'ssh' }>,
  sessionPath: string,
  identity: string
): Promise<{ ctx: IExecutionContext; root: string }> {
  const proxy = await ensureSshConnected(transport.connectionId, transport.host);
  const ctx = new SshExecutionContext(proxy, { root: sessionPath });
  const key = createHash('sha256').update(identity).digest('hex');
  const { stdout } = await ctx.exec('node', [
    '-e',
    RESOLVE_STATE_ROOT,
    key,
    'sdk-watchers',
    identity,
  ]);
  return { ctx, root: stdout.trim() };
}

export async function runSharedHostCommand(
  transport: LocationTransport,
  deployed: Awaited<ReturnType<typeof deploySharedHost>>,
  config: unknown,
  mode: '--ensure' | '--ensure-watch' | '--restart',
  resuming: boolean
) {
  const local = await mkdtemp(join(tmpdir(), 'switch-sdk-launch-'));
  const localFile = join(local, 'config.json');
  let remote: string | null = null;
  try {
    await writeFile(localFile, JSON.stringify(config), { mode: 0o600 });
    let configPath = localFile;
    if (transport.kind === 'ssh') {
      const proxy = await ensureSshConnected(transport.connectionId, transport.host);
      const result = await deployed.ctx.exec('node', [
        '-e',
        MAKE_LAUNCH_DIR,
        deployed.root,
        String(STALE_LAUNCH_MS),
      ]);
      remote = result.stdout.trim();
      const fs = new SshFileSystem(proxy, remote);
      try {
        await fs.copyLocalFile(localFile, 'config.json');
      } finally {
        fs.close();
      }
      configPath = `${remote}/config.json`;
      await deployed.ctx.exec('node', [
        '-e',
        "require('node:fs').chmodSync(process.argv[1],0o600)",
        configPath,
      ]);
    }
    return await deployed.ctx.exec('node', [
      deployed.entrypoint,
      deployed.root,
      configPath,
      mode,
      String(resuming),
    ]);
  } finally {
    try {
      if (remote)
        await deployed.ctx.exec('node', [
          '-e',
          "require('node:fs').rmSync(process.argv[1],{recursive:true,force:true})",
          remote,
        ]);
    } finally {
      await rm(local, { recursive: true, force: true });
    }
  }
}
