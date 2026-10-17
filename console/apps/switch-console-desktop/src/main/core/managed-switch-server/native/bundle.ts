import { readFile } from 'node:fs/promises';
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
