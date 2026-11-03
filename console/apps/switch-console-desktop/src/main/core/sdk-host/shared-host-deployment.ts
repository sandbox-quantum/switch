import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { resolveSharedHostBundlePath } from '@main/core/agent-runtime/impl/resolve-sidecar-bundle';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { SshFileSystem } from '@main/core/fs/impl/ssh-fs';
import type { LocationTransport } from '@main/core/locations/location-transport';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import { log } from '@main/lib/logger';
import { ensureHostBundle, forgetHostBundle, type HostBundle } from './host-bundle';
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
  return locateBundle(transport, dir, await bundleName());
}

/** The last bundle hashed, so a file that has not changed is not read again. */
let hashed: { path: string; mtimeMs: number; size: number; name: string } | null = null;

/** This build's bundle's file name on a host: named after its SHA-256. */
async function bundleName(): Promise<string> {
  const path = resolveSharedHostBundlePath();
  const { mtimeMs, size } = await stat(path);
  if (hashed?.path === path && hashed.mtimeMs === mtimeMs && hashed.size === size)
    return hashed.name;
  const hash = createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
  hashed = { path, mtimeMs, size, name: `shared-host-${hash}.mjs` };
  return hashed.name;
}

async function locateBundle(
  transport: Extract<LocationTransport, { kind: 'ssh' }>,
  dir: string,
  name: string
): Promise<{ ctx: IExecutionContext; entrypoint: string } | null> {
  const proxy = await ensureSshConnected(transport.connectionId, transport.host);
  const ctx = new SshExecutionContext(proxy, { root: dir });
  const { stdout } = await ctx.exec('node', ['-e', LOCATE_BUNDLE, name]);
  const entrypoint = stdout.trim();
  if (entrypoint) return { ctx, entrypoint };
  ctx.dispose();
  return null;
}

/** How much a one-off command may print here before Node stops reading it. */
const REQUEST_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Answers a request with one of this build's shared host's one-off commands.
 * The request is staged as a file only the user can read, in a private
 * directory beside a launch's configuration, and removed afterwards, since it
 * can carry a shell setup a command line would show to `ps`. Here it runs on
 * Console's own runtime, as local sessions do; on an SSH host it runs on the
 * host's `node`.
 *
 * `deploy` uploads this build's bundle to an SSH host first when it is not
 * there, which only a launch may do. Without it the command runs only where
 * this build's bundle already is: reading a host must not change what is
 * installed there, and an earlier build's bundle may not know the command.
 */
export async function runHostRequest(
  transport: LocationTransport,
  mode: string,
  request: unknown,
  options: { deploy: boolean; timeout: number }
): Promise<{ stdout: string; stderr: string }> {
  if (transport.kind !== 'ssh') {
    const local = await mkdtemp(join(tmpdir(), 'switch-sdk-request-'));
    const ctx = new LocalExecutionContext();
    try {
      const path = join(local, 'request.json');
      await writeFile(path, JSON.stringify(request), { mode: 0o600 });
      return await ctx.exec(process.execPath, [resolveSharedHostBundlePath(), mode, path], {
        env: { ELECTRON_RUN_AS_NODE: '1' },
        timeout: options.timeout,
        maxBuffer: REQUEST_MAX_BUFFER,
      });
    } finally {
      ctx.dispose();
      await rm(local, { recursive: true, force: true });
    }
  }
  const bundle = options.deploy
    ? await ensureHostBundle(transport)
    : await thisBuildsBundle(transport);
  if (!bundle)
    throw new Error(
      `${transport.host} does not have this version of Switch Console's host yet. Start a session for an agent there, or press Update on its Room watcher, then try again.`
    );
  const proxy = await ensureSshConnected(transport.connectionId, transport.host);
  const ctx = new SshExecutionContext(proxy, { root: transport.dir });
  let staged: string | null = null;
  try {
    // Staged as a launch is, and sweeping what abandoned launches left: the
    // script takes a state root, and finds `sdk-launch` beside its kind.
    const root = posix.join(posix.dirname(bundle.staging), 'sdk-sessions', 'cli-conversations');
    staged = (
      await ctx.exec('node', ['-e', MAKE_LAUNCH_DIR, root, String(STALE_LAUNCH_MS)])
    ).stdout.trim();
    const local = await mkdtemp(join(tmpdir(), 'switch-sdk-request-'));
    const fs = new SshFileSystem(proxy, staged);
    try {
      await writeFile(join(local, 'request.json'), JSON.stringify(request), { mode: 0o600 });
      await fs.copyLocalFile(join(local, 'request.json'), 'request.json');
    } finally {
      fs.close();
      await rm(local, { recursive: true, force: true });
    }
    const path = `${staged}/request.json`;
    await ctx.exec('node', ['-e', "require('node:fs').chmodSync(process.argv[1],0o600)", path]);
    return await ctx.exec('node', [bundle.entrypoint, mode, path], { timeout: options.timeout });
  } catch (error) {
    // A bundle that has gone is one reason a launch fails; the next checks
    // again. A command that ran and refused says nothing about the bundle.
    const stderr = (error as { stderr?: unknown }).stderr;
    if (
      options.deploy &&
      typeof stderr === 'string' &&
      stderr.includes(posix.basename(bundle.entrypoint))
    )
      forgetHostBundle(transport.connectionId);
    throw error;
  } finally {
    // Not allowed to hide why the command failed. What is left is swept with
    // abandoned launches (`HOST_PREPARE`).
    if (staged)
      await ctx
        .exec('node', [
          '-e',
          "require('node:fs').rmSync(process.argv[1],{recursive:true,force:true})",
          staged,
        ])
        .catch((error: unknown) =>
          log.warn('Could not remove a staged host request', {
            host: transport.host,
            error: String(error),
          })
        );
    ctx.dispose();
  }
}

/**
 * This build's bundle on an SSH host, found without deploying it, or null when
 * the host has another build's or none. Its staging directory sits beside the
 * bundle's, where `HOST_PREPARE` made both.
 */
async function thisBuildsBundle(
  transport: Extract<LocationTransport, { kind: 'ssh' }>
): Promise<HostBundle | null> {
  const name = await bundleName();
  const located = await locateBundle(transport, transport.dir, name);
  if (!located) return null;
  located.ctx.dispose();
  if (posix.basename(located.entrypoint) !== name) return null;
  return {
    entrypoint: located.entrypoint,
    staging: posix.join(posix.dirname(posix.dirname(located.entrypoint)), 'sdk-launch'),
  };
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
