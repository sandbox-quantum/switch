import { access, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { log } from '@main/lib/logger';
import { CHECKOUT_IMAGE_TAG } from '@shared/core/managed-switch-server/managed-switch-server';
import { downloadFile, extractArchive } from './download';
import type { NativeLayout } from './native-paths';
import { runCommand } from './run-command';
import { SWITCH_CORE_PYTHON, switchSourceArchiveUrl } from './toolchain-pins';
import type { UvBinary } from './uv';

const SYNC_TIMEOUT_MS = 20 * 60 * 1000;
const MARKER_FILE = 'installed.json';

export type SwitchCoreInstall = {
  /** What is installed: the release version, or {@link CHECKOUT_IMAGE_TAG}. */
  version: string;
  /** The root of the Switch source tree the install came from. */
  sourceRoot: string;
  /** The `core/` project directory: switch-core's working directory. */
  projectDir: string;
  /** The environment's Python interpreter. */
  python: string;
};

function venvPython(venv: string): string {
  return process.platform === 'win32'
    ? path.join(venv, 'Scripts', 'python.exe')
    : path.join(venv, 'bin', 'python');
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** The environment uv runs with: its cache and the Pythons it fetches are
 * kept under the local server's directory, so a reset can clear them and the
 * user's own uv setup is neither used nor disturbed. */
export function uvEnvironment(layout: NativeLayout, venv: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    UV_PROJECT_ENVIRONMENT: venv,
    UV_CACHE_DIR: layout.uvCache,
    UV_PYTHON_INSTALL_DIR: layout.uvPython,
    // A Python uv installed itself, never whatever happens to be on PATH: the
    // server should run on the same interpreter on every machine.
    UV_PYTHON_PREFERENCE: 'only-managed',
    UV_NO_PROGRESS: '1',
    VIRTUAL_ENV: '',
  };
}

async function uvSync(
  uv: UvBinary,
  layout: NativeLayout,
  projectDir: string,
  venv: string,
  onLine: (line: string) => void
): Promise<void> {
  // `--frozen` installs exactly the lockfile the release was tested with, the
  // same command the published image is built by.
  await runCommand(
    uv.path,
    ['sync', '--frozen', '--no-dev', '--python', SWITCH_CORE_PYTHON, '--project', projectDir],
    { cwd: projectDir, env: uvEnvironment(layout, venv), onLine, timeoutMs: SYNC_TIMEOUT_MS }
  );
}

async function readMarker(dir: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, MARKER_FILE), 'utf8')) as {
      version?: unknown;
    };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Make switch-core `version` runnable: its tagged source, unpacked, with an
 * environment uv built from the release's own lockfile. Kept per version and
 * reused, so only the first start of a version downloads anything.
 *
 * With `checkoutRoot` (dev builds only) the checkout's own `core/` is used
 * instead and re-synced on every start, so a start runs whatever is in the
 * working tree.
 */
export async function installSwitchCore(opts: {
  layout: NativeLayout;
  uv: UvBinary;
  version: string;
  owner: string;
  repo: string;
  checkoutRoot: string | null;
  onMessage: (message: string) => void;
  onLog: (line: string) => void;
}): Promise<SwitchCoreInstall> {
  const { layout, uv, version, owner, repo, checkoutRoot, onMessage, onLog } = opts;

  if (checkoutRoot !== null) {
    const projectDir = path.join(checkoutRoot, 'core');
    const venv = path.join(layout.switchCore, CHECKOUT_IMAGE_TAG, 'venv');
    onMessage(`Installing switch-core from ${checkoutRoot}…`);
    await uvSync(uv, layout, projectDir, venv, onLog);
    return {
      version: CHECKOUT_IMAGE_TAG,
      sourceRoot: checkoutRoot,
      projectDir,
      python: venvPython(venv),
    };
  }

  const dir = path.join(layout.switchCore, version);
  const src = path.join(dir, 'src');
  const projectDir = path.join(src, 'core');
  const venv = path.join(dir, 'venv');
  const python = venvPython(venv);
  if ((await readMarker(dir)) === version && (await exists(python))) {
    return { version, sourceRoot: src, projectDir, python };
  }

  onMessage(`Downloading switch-core ${version}…`);
  const archive = path.join(layout.downloads, `switch-${version}.tar.gz`);
  try {
    // No pinned checksum is possible for a release that may postdate this
    // build; the tag names the content, fetched from GitHub over TLS.
    await downloadFile(switchSourceArchiveUrl(owner, repo, version), archive, null);
    await extractArchive(archive, src, 1);
  } finally {
    await rm(archive, { force: true });
  }

  onMessage(`Installing switch-core ${version} (first start of this version)…`);
  await rm(venv, { recursive: true, force: true });
  await uvSync(uv, layout, projectDir, venv, onLog);
  await writeFile(
    path.join(dir, MARKER_FILE),
    `${JSON.stringify({ version, uv: uv.version }, null, 2)}\n`
  );
  return { version, sourceRoot: src, projectDir, python };
}

/** Remove installed releases other than `keep`, once a start on it has
 * succeeded. The checkout environment is left alone. */
export async function pruneSwitchCoreInstalls(layout: NativeLayout, keep: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(layout.switchCore);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === keep || entry === CHECKOUT_IMAGE_TAG) continue;
    log.info(`local-switch-server: removing the switch-core ${entry} install it no longer runs`);
    await rm(path.join(layout.switchCore, entry), { recursive: true, force: true });
  }
}
