import { createHash } from 'node:crypto';
import { access, cp, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { log } from '@main/lib/logger';
import { exe } from './native-paths';
import { BUNDLE_FORMAT, SWITCH_CORE_PYTHON } from './toolchain-pins';

/**
 * What a packaged Console ships for the native local server, so a first start
 * downloads nothing (scripts/build-local-server-bundle.mjs builds it). A dev
 * build has none and downloads instead; so does a build whose bundle is for
 * another switch-core than it pins, which would install the wrong server.
 */
export type LocalServerBundle = {
  root: string;
  /** When the bundle was built: changes with every build, so an install
   * made from an older bundle is redone. */
  builtAt: string;
  switchVersion: string;
  /** The portable PostgreSQL's `bin/`, or null where none is published. */
  postgresBinDir: string | null;
  postgresVersion: string | null;
  uv: string;
  python: string;
  /** Root of the switch-core source tree: `core/` and the setup script. */
  switchSource: string;
  /** switch-core's dependencies, installed, for the environment to reach
   * through a `.pth` file. */
  sitePackages: string;
  /** Pure-Python wheels the editable install of switch-core builds with. */
  buildWheels: string;
};

type Manifest = {
  bundle?: unknown;
  switchVersion?: unknown;
  postgresVersion?: unknown;
  builtAt?: unknown;
};

/**
 * The bundle at `root`, or null when there is none to use there. A bundle
 * that is present but unusable is logged, not thrown: Console then falls back
 * to downloading, which works, rather than refusing to set up the server.
 */
export async function readLocalServerBundle(
  root: string | null,
  expectedSwitchVersion: string
): Promise<LocalServerBundle | null> {
  if (root === null) return null;
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')) as Manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('local-switch-server: the bundled server is unreadable; downloading instead', {
        root,
        error: String(error),
      });
    }
    return null;
  }
  if (manifest.bundle !== BUNDLE_FORMAT || typeof manifest.builtAt !== 'string') {
    log.warn('local-switch-server: the bundled server has an unknown layout; downloading instead', {
      root,
    });
    return null;
  }
  if (manifest.switchVersion !== expectedSwitchVersion) {
    log.warn(
      `local-switch-server: the bundled server is switch-core ${String(manifest.switchVersion)}, ` +
        `not the ${expectedSwitchVersion} this build pins; downloading instead`
    );
    return null;
  }
  const postgresVersion =
    typeof manifest.postgresVersion === 'string' ? manifest.postgresVersion : null;
  return {
    root,
    builtAt: manifest.builtAt,
    switchVersion: expectedSwitchVersion,
    postgresBinDir: postgresVersion === null ? null : path.join(root, 'postgres', 'bin'),
    postgresVersion,
    uv: path.join(root, 'uv', exe('uv')),
    python:
      process.platform === 'win32'
        ? path.join(root, 'python', 'python.exe')
        : path.join(root, 'python', 'bin', `python${SWITCH_CORE_PYTHON}`),
    switchSource: path.join(root, 'switch', 'src'),
    sitePackages: path.join(root, 'switch', 'site-packages'),
    buildWheels: path.join(root, 'switch', 'build-wheels'),
  };
}

const COPY_PREFIX = 'bundle-';

/**
 * The bundle, copied out of the app into the local server's own directory,
 * which is where the server then runs from.
 *
 * Running PostgreSQL and Python from inside the app ties the server to wherever
 * the app happens to be: an AppImage is mounted at a new path on every launch
 * and unmounted when it quits, taking the running server's files with it; on
 * Windows an update cannot replace files a running server holds open; and a
 * moved app leaves the server pointing at nothing. A copy has none of that,
 * for the price of the disk it takes. Made once per bundle build, and only
 * named as complete once fully written.
 */
export async function materializeBundle(
  bundle: LocalServerBundle,
  toolchainDir: string,
  onMessage: (message: string) => void
): Promise<LocalServerBundle> {
  const id = createHash('sha256')
    .update(`${bundle.switchVersion}\n${bundle.builtAt}`)
    .digest('hex')
    .slice(0, 12);
  const destination = path.join(toolchainDir, `${COPY_PREFIX}${id}`);
  try {
    await access(path.join(destination, 'manifest.json'));
  } catch {
    onMessage('Unpacking the Switch server…');
    const staging = `${destination}.copying`;
    await rm(staging, { recursive: true, force: true });
    await cp(bundle.root, staging, { recursive: true, verbatimSymlinks: true });
    await rename(staging, destination);
  }
  const copy = await readLocalServerBundle(destination, bundle.switchVersion);
  if (copy === null) {
    throw new Error(`The copy of the bundled server in ${destination} is unreadable.`);
  }
  return copy;
}

/** Remove copies of older bundles once a start on `keep` has succeeded. */
export async function pruneBundleCopies(toolchainDir: string, keep: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(toolchainDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const dir = path.join(toolchainDir, entry);
    if (!entry.startsWith(COPY_PREFIX) || dir === keep) continue;
    log.info(`local-switch-server: removing the old bundle copy ${entry}`);
    await rm(dir, { recursive: true, force: true });
  }
}
