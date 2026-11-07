import { execFile } from 'node:child_process';
import { appendFile, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { log } from '@main/lib/logger';
import { CHECKOUT_IMAGE_TAG } from '@shared/core/managed-switch-server/managed-switch-server';
import type { LocalServerBundle } from './bundle';
import { downloadFile, extractArchive } from './download';
import {
  buildGatewayUi,
  checkoutGatewayUi,
  GATEWAY_UI_DIR_NAME,
  gatewayUiBuildFailed,
  gatewayUiFailedMarker,
  gatewayUiOrNull,
} from './gateway-ui';
import type { NativeLayout } from './native-paths';
import { runCommand } from './run-command';
import { SWITCH_CORE_PYTHON, switchSourceArchiveUrl } from './toolchain-pins';
import type { UvBinary } from './uv';

const execFileAsync = promisify(execFile);

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
  /** The gateway's built pages for switch-core to serve, or null when there
   * are none to hand it (see gateway-ui.ts). */
  gatewayUiDir: string | null;
};

function venvPython(venv: string): string {
  return process.platform === 'win32'
    ? path.join(venv, 'Scripts', 'python.exe')
    : path.join(venv, 'bin', 'python');
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

/**
 * Install the environment. uv's per-package output goes to `install.log`, not
 * the UI's log tail, where hundreds of lines would bury whatever went wrong;
 * a failure still carries uv's last words in its message.
 */
async function uvSync(
  uv: UvBinary,
  layout: NativeLayout,
  projectDir: string,
  venv: string
): Promise<void> {
  await mkdir(layout.logs, { recursive: true });
  const installLog = path.join(layout.logs, 'install.log');
  await appendFile(installLog, `\n# uv sync ${projectDir} (${new Date().toISOString()})\n`);
  const lines: string[] = [];
  const onLine = (line: string) => lines.push(line);
  // `--frozen` installs exactly the lockfile the release was tested with, the
  // same command the published image is built by.
  try {
    await runCommand(
      uv.path,
      ['sync', '--frozen', '--no-dev', '--python', SWITCH_CORE_PYTHON, '--project', projectDir],
      { cwd: projectDir, env: uvEnvironment(layout, venv), onLine, timeoutMs: SYNC_TIMEOUT_MS }
    );
  } finally {
    await appendFile(installLog, `${lines.join('\n')}\n`);
  }
}

type Marker = { version?: unknown; source?: unknown; bundleRoot?: unknown; format?: unknown };

/** Raised when how an install from the bundle is laid out changes, so one made
 * the old way is redone (2: the bundle is reached as a site directory; 3: the
 * gateway's pages are copied beside the source). */
const BUNDLE_INSTALL_FORMAT = '3';

/** What the install in `dir` was made from, or null when there is none. */
async function readMarker(dir: string): Promise<Marker | null> {
  try {
    return JSON.parse(await readFile(path.join(dir, MARKER_FILE), 'utf8')) as Marker;
  } catch {
    return null;
  }
}

/**
 * Whether a dev build with no bundle, starting switch-core `version`, would
 * hand it the gateway's pages. An install of that version already there is
 * reused as it is (see `markerMatches`): one made from a bundle has whatever
 * the bundle shipped and is never built for, having no gateway source. A
 * downloaded one, or none yet, gets its pages built, unless building them for
 * it already failed in a way that would repeat.
 */
export async function downloadedInstallWouldServePages(
  layout: NativeLayout,
  version: string
): Promise<boolean> {
  const dir = path.join(layout.switchCore, version);
  const gatewayUi = path.join(dir, GATEWAY_UI_DIR_NAME);
  const marker = await readMarker(dir);
  if (marker?.version === version && marker.source === 'bundle') {
    return (await gatewayUiOrNull(gatewayUi)) !== null;
  }
  return !(await gatewayUiBuildFailed(gatewayUi));
}

/** Whether an install made from `marker` serves `version` from `bundle`: one
 * made from another copy of the bundle is redone, so old copies can go. */
function markerMatches(
  marker: Marker | null,
  version: string,
  bundle: LocalServerBundle | null
): boolean {
  if (marker?.version !== version) return false;
  if (bundle === null) return true;
  return (
    marker.source === 'bundle' &&
    marker.bundleRoot === bundle.root &&
    marker.format === BUNDLE_INSTALL_FORMAT
  );
}

/**
 * Make switch-core `version` runnable: its tagged source, unpacked, with an
 * environment uv built from the release's own lockfile. Kept per version and
 * reused, so only the first start of a version downloads anything.
 *
 * With `checkoutRoot` (dev builds only) the checkout's own `core/` is used
 * instead and re-synced on every start, so a start runs whatever is in the
 * working tree.
 *
 * The gateway's pages come along: copied from the bundle, the checkout's own
 * build, or — with `buildGatewayUiFromSource`, for dev builds — built from the
 * downloaded source once per version.
 */
export async function installSwitchCore(opts: {
  layout: NativeLayout;
  uv: UvBinary;
  bundle: LocalServerBundle | null;
  version: string;
  owner: string;
  repo: string;
  checkoutRoot: string | null;
  /** Build the gateway's pages from a downloaded source when the install has
   * none: dev builds, which have Node and npm, only. */
  buildGatewayUiFromSource: boolean;
  onMessage: (message: string) => void;
}): Promise<SwitchCoreInstall> {
  const { layout, uv, bundle, version, owner, repo, checkoutRoot, onMessage } = opts;

  if (checkoutRoot !== null) {
    const projectDir = path.join(checkoutRoot, 'core');
    const venv = path.join(layout.switchCore, CHECKOUT_IMAGE_TAG, 'venv');
    onMessage(`Installing switch-core from ${checkoutRoot}…`);
    await uvSync(uv, layout, projectDir, venv);
    const gatewayUiDir = await checkoutGatewayUi(checkoutRoot);
    if (gatewayUiDir === null) {
      onMessage(
        'The checkout has no build of the admin pages, so the server starts without them; ' +
          'run `just gateway-build` and restart it to add them.'
      );
    }
    return {
      version: CHECKOUT_IMAGE_TAG,
      sourceRoot: checkoutRoot,
      projectDir,
      python: venvPython(venv),
      gatewayUiDir,
    };
  }

  const dir = path.join(layout.switchCore, version);
  const src = path.join(dir, 'src');
  const projectDir = path.join(src, 'core');
  const venv = path.join(dir, 'venv');
  const python = venvPython(venv);
  const gatewayUi = path.join(dir, GATEWAY_UI_DIR_NAME);
  // A downloaded install whose pages are missing (one made before they were
  // built) gets a go at them, unless building them for this install already
  // failed; a bundled one has whatever its bundle shipped.
  const pagesFor = async (source: 'bundle' | 'download'): Promise<string | null> => {
    const existing = await gatewayUiOrNull(gatewayUi);
    if (existing !== null || source === 'bundle' || !opts.buildGatewayUiFromSource) {
      return existing;
    }
    if (await gatewayUiBuildFailed(gatewayUi)) return null;
    return buildGatewayUi({ layout, sourceRoot: src, destination: gatewayUi, onMessage });
  };
  // Checked by running it, not by its file existing: an environment made from
  // the app's bundled Python stops working if the app moves.
  const marker = await readMarker(dir);
  if (markerMatches(marker, version, bundle) && (await runs(python))) {
    const source = marker?.source === 'bundle' ? 'bundle' : 'download';
    return { version, sourceRoot: src, projectDir, python, gatewayUiDir: await pagesFor(source) };
  }

  if (bundle !== null) {
    onMessage(`Installing switch-core ${version}…`);
    await installFromBundle(layout, uv, bundle, src, venv);
    await rm(gatewayUi, { recursive: true, force: true });
    if (bundle.gatewayUi !== null) await cp(bundle.gatewayUi, gatewayUi, { recursive: true });
    await writeMarker(dir, {
      version,
      source: 'bundle',
      bundleRoot: bundle.root,
      format: BUNDLE_INSTALL_FORMAT,
    });
    return { version, sourceRoot: src, projectDir, python, gatewayUiDir: await pagesFor('bundle') };
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
  await uvSync(uv, layout, projectDir, venv);
  await writeMarker(dir, { version, source: 'download', uv: uv.version });
  await rm(gatewayUi, { recursive: true, force: true });
  await rm(gatewayUiFailedMarker(gatewayUi), { force: true });
  return { version, sourceRoot: src, projectDir, python, gatewayUiDir: await pagesFor('download') };
}

async function writeMarker(dir: string, marker: Record<string, string>): Promise<void> {
  await writeFile(path.join(dir, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`);
}

/** Whether the environment's Python runs and finds switch-core's compiled
 * dependencies: an environment made from the app's bundle stops finding
 * them if the app moves. */
async function runs(python: string): Promise<boolean> {
  try {
    await execFileAsync(python, ['-c', 'import asyncpg, pydantic_core, switch_core'], {
      timeout: 60_000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Install from what the app ships, without the network: copy the release's
 * source out of the app (an update replaces the bundle), make an environment
 * on the bundled Python that reaches the bundled, already-installed
 * dependencies through a `.pth` file — they stay where the app's signature
 * covers them — then install switch-core itself, editable as the download
 * path does, so its migrations and version metadata are where it looks.
 */
async function installFromBundle(
  layout: NativeLayout,
  uv: UvBinary,
  bundle: LocalServerBundle,
  src: string,
  venv: string
): Promise<void> {
  await rm(src, { recursive: true, force: true });
  await rm(venv, { recursive: true, force: true });
  await cp(bundle.switchSource, src, { recursive: true });
  await mkdir(layout.logs, { recursive: true });
  const installLog = path.join(layout.logs, 'install.log');
  const lines: string[] = [];
  const env: NodeJS.ProcessEnv = {
    ...uvEnvironment(layout, venv),
    UV_OFFLINE: '1',
    UV_PYTHON_DOWNLOADS: 'never',
    UV_PYTHON_PREFERENCE: 'only-system',
  };
  const uvRun = (args: string[]) =>
    runCommand(uv.path, args, {
      cwd: layout.root,
      env,
      onLine: (line) => lines.push(line),
      timeoutMs: SYNC_TIMEOUT_MS,
    });
  try {
    await appendFile(installLog, `\n# install from ${bundle.root} (${new Date().toISOString()})\n`);
    await uvRun(['venv', '--python', bundle.python, venv]);
    await writeFile(
      path.join(await venvSitePackages(venv), 'switch-bundle.pth'),
      bundlePthLine(bundle.sitePackages)
    );
    await uvRun([
      'pip',
      'install',
      '--python',
      venvPython(venv),
      '--no-index',
      '--find-links',
      bundle.buildWheels,
      '--no-deps',
      '-e',
      path.join(src, 'core'),
    ]);
  } finally {
    await appendFile(installLog, `${lines.join('\n')}\n`);
  }
}

/**
 * The `.pth` line that puts the bundled packages on the path as a site
 * directory, not a bare path: some packages (pywin32, which mcp needs on
 * Windows) add their own directories through `.pth` files of their own, and
 * Python reads those only in a site directory. The path is written as a JSON
 * string, which is also a valid Python string literal.
 */
export function bundlePthLine(sitePackages: string): string {
  return `import site; site.addsitedir(${JSON.stringify(sitePackages)})\n`;
}

/** The environment's `site-packages` directory. */
async function venvSitePackages(venv: string): Promise<string> {
  if (process.platform === 'win32') return path.join(venv, 'Lib', 'site-packages');
  const lib = path.join(venv, 'lib');
  const python = (await readdir(lib)).find((entry) => entry.startsWith('python'));
  if (!python) throw new Error(`The environment in ${venv} has no lib/python* directory.`);
  return path.join(lib, python, 'site-packages');
}

/**
 * The install a start already made for `version`, without installing anything,
 * or null when there is none that runs. For acting on a running server
 * (bringing its Mattermost up) without going through a start.
 */
export async function existingSwitchCoreInstall(
  layout: NativeLayout,
  version: string,
  checkoutRoot: string | null
): Promise<SwitchCoreInstall | null> {
  if (checkoutRoot !== null) {
    const python = venvPython(path.join(layout.switchCore, CHECKOUT_IMAGE_TAG, 'venv'));
    return (await runs(python))
      ? {
          version: CHECKOUT_IMAGE_TAG,
          sourceRoot: checkoutRoot,
          projectDir: path.join(checkoutRoot, 'core'),
          python,
          gatewayUiDir: await checkoutGatewayUi(checkoutRoot),
        }
      : null;
  }
  const dir = path.join(layout.switchCore, version);
  const src = path.join(dir, 'src');
  const python = venvPython(path.join(dir, 'venv'));
  if ((await readMarker(dir))?.version !== version || !(await runs(python))) return null;
  return {
    version,
    sourceRoot: src,
    projectDir: path.join(src, 'core'),
    python,
    gatewayUiDir: await gatewayUiOrNull(path.join(dir, GATEWAY_UI_DIR_NAME)),
  };
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
