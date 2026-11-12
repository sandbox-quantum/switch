/**
 * Build the gateway's pages (the admin dashboard) from a Switch source tree's
 * `gateway/` and copy the build to a directory, as the published image builds
 * them. The local-server bundle uses it for the release it bundles; PR CI runs
 * it on its own, against the branch's `gateway/`, so a change to this step is
 * tried on Linux and Windows before a release depends on it:
 *
 *   node scripts/build-gateway-ui.mjs <gateway source dir> <destination>
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildGatewayUi(gatewaySource, destination) {
  // The build tools are dev dependencies, which npm drops under
  // NODE_ENV=production; Windows' npm is a .cmd script, run through a shell.
  const env = { ...process.env };
  delete env.NODE_ENV;
  const npm = (args) =>
    execFileSync('npm', args, {
      cwd: gatewaySource,
      stdio: 'inherit',
      env,
      shell: process.platform === 'win32',
    });
  npm(['ci', '--no-audit', '--no-fund']);
  npm(['run', 'build']);
  await rm(destination, { recursive: true, force: true });
  await cp(path.join(gatewaySource, 'dist'), destination, { recursive: true });
  if (!existsSync(path.join(destination, 'index.html'))) {
    throw new Error(`The gateway build in ${gatewaySource} produced no index.html`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination) {
    console.error('usage: node scripts/build-gateway-ui.mjs <gateway source dir> <destination>');
    process.exit(2);
  }
  await buildGatewayUi(path.resolve(source), path.resolve(destination));
  console.log(`gateway pages built into ${path.resolve(destination)}`);
}
