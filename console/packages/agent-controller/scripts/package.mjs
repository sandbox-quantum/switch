import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/**
 * Builds the installable controller: one npm package holding the CLI and the
 * shared-host bundle it runs agents with, each bundled whole so the package
 * has no dependencies to install, then packs it into
 * `dist-package/switch-agent-controller-<version>.tgz` for
 * `npm install --global <file or URL>`.
 *
 * The version is this package's: a release sets it from the tag before
 * running this, and the CLI reports what it was built with.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist-package');
const stage = join(out, 'package');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const { version } = manifest;
if (!/^\d+\.\d+\.\d+$/.test(version))
  throw new Error(`The package version must be x.y.z to be released, not '${version}'.`);

/** Kept out, as in Switch Console's own bundle: the controller must stay headless. */
const FORBIDDEN = ['electron', 'better-sqlite3', 'drizzle-orm'];
const headless = {
  name: 'headless',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /.*/ }, (args) => {
      const hit = FORBIDDEN.find((name) => args.path === name || args.path.startsWith(`${name}/`));
      return hit
        ? {
            errors: [
              { text: `The controller must not depend on '${hit}' (from ${args.importer}).` },
            ],
          }
        : null;
    });
  },
};
const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'warning',
  plugins: [headless],
  // Bundled CommonJS dependencies still call require.
  banner: {
    js: "import { createRequire as createPackagedRequire } from 'node:module'; const require = createPackagedRequire(import.meta.url);",
  },
};

await rm(out, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await build({
  ...common,
  entryPoints: [join(root, 'src', 'cli.ts')],
  outfile: join(stage, 'cli.mjs'),
  tsconfig: join(root, 'tsconfig.json'),
});
await build({
  ...common,
  entryPoints: [join(root, '..', 'agent-providers', 'src', 'host', 'shared-daemon.ts')],
  // The name the CLI looks for beside itself (PACKAGED_SHARED_HOST_BUNDLE).
  outfile: join(stage, 'shared-host.mjs'),
  tsconfig: join(root, '..', 'agent-providers', 'tsconfig.json'),
});
await writeFile(
  join(stage, 'package.json'),
  `${JSON.stringify(
    {
      name: 'switch-agent-controller',
      version,
      description: manifest.description,
      license: manifest.license,
      type: 'module',
      bin: { 'switch-agent-controller': './cli.mjs' },
      files: ['cli.mjs', 'shared-host.mjs', 'README.md', 'LICENSE'],
      engines: manifest.engines,
      os: ['darwin', 'linux'],
    },
    null,
    2
  )}\n`
);
await copyFile(join(root, 'README.md'), join(stage, 'README.md'));
await copyFile(join(root, '..', '..', '..', 'LICENSE'), join(stage, 'LICENSE'));
execFileSync('npm', ['pack', '--pack-destination', out], { cwd: stage, stdio: 'inherit' });
process.stdout.write(`${join(out, `switch-agent-controller-${version}.tgz`)}\n`);
