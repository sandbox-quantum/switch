import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Reset the macOS Launch Services registration for the `switchdash://` URL
 * scheme. Running the dev app with SWITCHDASH_REGISTER_DEEPLINK=1 points the
 * scheme at the bare Electron binary in node_modules; that registration persists
 * after the dev process exits and steals deeplinks from the installed app
 * (showing Electron's default welcome window instead). This unregisters the
 * stale dev Electron bundle and re-registers the installed app, then asks you to
 * launch the installed app once so it reclaims the scheme as default handler.
 *
 * macOS-only: on other platforms the scheme is registered per-launch / via the
 * desktop entry, so there is no persistent stale state to clear.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(appRoot, '..', '..');

const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister';

if (process.platform !== 'darwin') {
  console.log('reset-deeplink-handler: only needed on macOS — nothing to do.');
  process.exit(0);
}

function lsregister(args: string[], { allowFailure = false } = {}): void {
  const result = spawnSync(LSREGISTER, args, { stdio: 'inherit' });
  if (result.error) {
    console.error('reset-deeplink-handler: failed to run lsregister:', result.error);
    if (!allowFailure) process.exit(1);
    return;
  }
  if (typeof result.status === 'number' && result.status !== 0 && !allowFailure) {
    process.exit(result.status);
  }
}

// Drop the stale dev Electron registration(s) that may still claim switchdash://.
// node_modules can be app-local or hoisted to the workspace root with pnpm.
const devElectronApps = [
  path.join(appRoot, 'node_modules', 'electron', 'dist', 'Electron.app'),
  path.join(workspaceRoot, 'node_modules', 'electron', 'dist', 'Electron.app'),
].filter((p) => existsSync(p));

for (const devApp of devElectronApps) {
  console.log(`Unregistering dev Electron: ${devApp}`);
  lsregister(['-u', devApp], { allowFailure: true });
}

// Re-register the installed app so Launch Services rediscovers it as the
// switchdash:// handler. The pre-rename bundle names are still listed: a machine
// that has not upgraded yet has the app under the old name and nothing else.
const installed = [
  '/Applications/Switch Console.app',
  path.join(process.env.HOME ?? '', 'Applications', 'Switch Console.app'),
  '/Applications/Switch Console Canary.app',
  '/Applications/Switchdash.app',
  path.join(process.env.HOME ?? '', 'Applications', 'Switchdash.app'),
  '/Applications/Switchdash Canary.app',
].find((p) => existsSync(p));

if (installed) {
  console.log(`Re-registering installed app: ${installed}`);
  lsregister(['-f', installed]);
  console.log(
    'Done. Launch the installed Switch Console app once — it reclaims switchdash:// as the default handler.'
  );
} else {
  console.log(
    'Stale dev handler cleared, but no installed Switch Console app was found.\n' +
      'Launch the installed app once and it will reclaim the switchdash:// scheme.'
  );
}
