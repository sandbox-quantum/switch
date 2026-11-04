import { appendFile, access, mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { log } from '@main/lib/logger';
import type { LocalServerAdminPages } from '@shared/core/managed-switch-server/managed-switch-server';
import { CORE_ENV_FILE } from './core-process';
import type { NativeLayout } from './native-paths';
import { runCommand } from './run-command';

/**
 * The gateway's built pages (the admin dashboard) for a native local server.
 *
 * switch-core serves them itself, on its own address, when `GATEWAY_UI_DIR`
 * names a directory holding a build — the published image does exactly that.
 * A native server has no image, so the build comes from wherever its
 * switch-core did: the app's bundle, the checkout it runs from, or (dev builds
 * only) built from the source a start downloaded. switch-core refuses to start
 * when `GATEWAY_UI_DIR` names a directory with no `index.html`, so a directory
 * is only ever handed over once that file is seen.
 */

/** Where an install keeps its copy of the pages, beside its `src/` and `venv/`. */
export const GATEWAY_UI_DIR_NAME = 'gateway-ui';

/** The variable switch-core reads the pages' directory from. */
export const GATEWAY_UI_ENV = 'GATEWAY_UI_DIR';

const BUILD_TIMEOUT_MS = 15 * 60 * 1000;

/** Whether `dir` holds a build of the pages switch-core will accept. */
export async function hasGatewayUiBuild(dir: string): Promise<boolean> {
  try {
    await access(path.join(dir, 'index.html'));
    return true;
  } catch {
    return false;
  }
}

/** `dir` when it holds a build, else null. */
export async function gatewayUiOrNull(dir: string): Promise<string | null> {
  return (await hasGatewayUiBuild(dir)) ? dir : null;
}

/** The checkout's own build of the pages (`just gateway-build`), or null when
 * it has none. Used as it is, so a rebuild shows at the next start. */
export function checkoutGatewayUi(checkoutRoot: string): Promise<string | null> {
  return gatewayUiOrNull(path.join(checkoutRoot, 'gateway', 'dist'));
}

/** `npm`, as something `spawn` can run on this platform: Windows' npm is a
 * `.cmd` script, which Node only runs through a shell. */
function npmCommand(args: string[]): [string, string[]] {
  if (process.platform === 'win32') return ['cmd.exe', ['/d', '/s', '/c', 'npm', ...args]];
  return ['npm', args];
}

/**
 * Build the pages from a downloaded Switch source tree into `destination`.
 * For dev builds only, which have Node and npm to hand; never fatal: the
 * server is better started without its admin pages than not at all, so a
 * failure is logged and reported, and null returned. The packages it installs
 * are removed again: only the build is kept.
 */
export async function buildGatewayUi(opts: {
  layout: NativeLayout;
  sourceRoot: string;
  destination: string;
  onMessage: (message: string) => void;
}): Promise<string | null> {
  const { layout, sourceRoot, destination, onMessage } = opts;
  const project = path.join(sourceRoot, 'gateway');
  try {
    await access(path.join(project, 'package.json'));
  } catch {
    log.warn(`local-switch-server: no gateway source in ${sourceRoot}; no admin pages`);
    return null;
  }
  onMessage('Building the admin pages (first start of this version)…');
  await mkdir(layout.logs, { recursive: true });
  const buildLog = path.join(layout.logs, 'gateway-build.log');
  const lines: string[] = [];
  // The build tools are dev dependencies, which npm leaves out under
  // NODE_ENV=production; the build sets its own mode.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_ENV;
  const run = (args: string[]) => {
    const [command, commandArgs] = npmCommand(args);
    return runCommand(command, commandArgs, {
      cwd: project,
      env,
      onLine: (line) => lines.push(line),
      timeoutMs: BUILD_TIMEOUT_MS,
    });
  };
  try {
    await appendFile(buildLog, `\n# build ${project} (${new Date().toISOString()})\n`);
    await run(['ci', '--no-audit', '--no-fund']);
    await run(['run', 'build']);
    await rm(destination, { recursive: true, force: true });
    await rename(path.join(project, 'dist'), destination);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.warn('local-switch-server: could not build the admin pages', { error: reason });
    onMessage(`Could not build the admin pages, so the server starts without them (${buildLog})`);
    return null;
  } finally {
    await appendFile(buildLog, `${lines.join('\n')}\n`).catch(() => undefined);
    await rm(path.join(project, 'node_modules'), { recursive: true, force: true }).catch(
      () => undefined
    );
  }
  return gatewayUiOrNull(destination);
}

/** Whether the running switch-core was started with the pages, read off the
 * environment it was started with: it refuses to start with a directory that
 * holds none, so one named there is one it serves. */
export async function runningServesAdminPages(layout: NativeLayout): Promise<boolean> {
  try {
    const env = await readFile(path.join(layout.run, CORE_ENV_FILE), 'utf8');
    return env.split('\n').some((line) => {
      if (!line.startsWith(`${GATEWAY_UI_ENV}=`)) return false;
      return line.slice(GATEWAY_UI_ENV.length + 1).trim() !== '';
    });
  } catch {
    return false;
  }
}

/**
 * What a running native server's admin pages are doing: served, or not yet
 * and a restart would bring them (a server started before this Console
 * shipped them keeps running without them across the update), or not and a
 * restart would not help either.
 */
export async function nativeAdminPages(
  layout: NativeLayout,
  restartWouldServe: () => Promise<boolean>
): Promise<LocalServerAdminPages> {
  if (await runningServesAdminPages(layout)) return 'served';
  return (await restartWouldServe()) ? 'restart' : 'unavailable';
}
