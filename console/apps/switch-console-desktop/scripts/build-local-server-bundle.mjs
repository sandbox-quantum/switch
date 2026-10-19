/**
 * Builds the native local server's bundle — everything a first start would
 * otherwise download — into `dist-local-server/`, which electron-builder ships
 * as the `local-server` resource:
 *
 *   postgres/   the pinned portable PostgreSQL, trimmed to what a server needs
 *   uv/         the pinned uv
 *   python/     a relocatable CPython 3.12, fetched by that uv
 *   switch/src  the pinned switch-core release's `core/` and its setup script
 *   switch/wheels, switch/requirements.txt
 *               every package switch-core needs, as wheels, with the hashes of
 *               the release's own lockfile — installed offline at first start
 *   manifest.json
 *
 * For the host platform only, like the native modules: the release workflow
 * builds each platform and arch on its own runner. Skipped when the bundle
 * already on disk is for the same versions, so a rebuild costs nothing.
 *
 * The pins (versions, URLs, checksums) and the switch-core version are read
 * from the app's own source, so the bundle can never disagree with the
 * runtime that unpacks it.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { build } from 'esbuild';

const OUT = path.resolve('dist-local-server');

/** Load a TypeScript module of this app, transpiled on the fly. */
async function loadTs(file, define = {}) {
  const result = await build({
    entryPoints: [file],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    define,
  });
  const code = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

const pins = await loadTs('src/main/core/managed-switch-server/native/toolchain-pins.ts');
const identity = await loadTs('src/shared/app-identity.ts', {
  'import.meta.env': JSON.stringify({ VITE_BUILD: process.env.VITE_BUILD ?? '' }),
});
const switchVersion = identity.COMPATIBLE_SWITCH_VERSION;
const platform = pins.currentNativePlatform(process.platform, process.arch);
if (!platform) {
  // Still made, empty: electron-builder ships whatever is there, and Console
  // then downloads what it needs.
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  console.log(`local-server bundle: no bundle for ${process.platform}-${process.arch}; skipping`);
  process.exit(0);
}

const wanted = {
  bundle: pins.BUNDLE_FORMAT,
  platform,
  switchVersion,
  uvVersion: pins.UV_VERSION,
  postgresVersion: pins.postgresArchive(platform) ? pins.POSTGRES_VERSION : null,
  python: pins.SWITCH_CORE_PYTHON,
};

try {
  const existing = JSON.parse(await readFile(path.join(OUT, 'manifest.json'), 'utf8'));
  if (Object.entries(wanted).every(([key, value]) => existing[key] === value)) {
    console.log(`local-server bundle: up to date for switch-core ${switchVersion} (${platform})`);
    process.exit(0);
  }
} catch {}

const work = await mkdtemp(path.join(os.tmpdir(), 'switch-local-server-bundle-'));
const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

function parseIntegrity(integrity) {
  if (integrity.startsWith('sha256:')) {
    return { algorithm: 'sha256', digest: integrity.slice(7), encoding: 'hex' };
  }
  const dash = integrity.indexOf('-');
  return {
    algorithm: integrity.slice(0, dash),
    digest: integrity.slice(dash + 1),
    encoding: 'base64',
  };
}

async function download(url, file, integrity) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Downloading ${url} failed: HTTP ${response.status}`);
  const expected = integrity ? parseIntegrity(integrity) : null;
  const hash = expected ? createHash(expected.algorithm) : null;
  const body = Readable.fromWeb(response.body);
  if (hash) body.on('data', (chunk) => hash.update(chunk));
  await pipeline(body, createWriteStream(file));
  if (expected && hash.digest(expected.encoding) !== expected.digest) {
    throw new Error(`${url} does not match its pinned checksum.`);
  }
}

// On Windows, the system bsdtar: the runner's PATH puts Git's GNU tar first,
// which reads `C:\…` as a remote host and cannot open zip.
const tarCommand = (() => {
  if (process.platform !== 'win32') return 'tar';
  if (!process.env.SystemRoot) throw new Error("SystemRoot is unset; cannot find Windows' tar.exe");
  const systemTar = path.win32.join(process.env.SystemRoot, 'System32', 'tar.exe');
  if (!existsSync(systemTar)) throw new Error(`Windows' tar.exe was not found at ${systemTar}`);
  return systemTar;
})();

function tar(args) {
  execFileSync(tarCommand, args, { stdio: 'inherit' });
}

async function unpackPinned(archive, destination) {
  const file = path.join(work, path.basename(new URL(archive.url).pathname));
  await download(archive.url, file, archive.integrity);
  await mkdir(destination, { recursive: true });
  const args = ['-xf', file, '-C', destination];
  if (archive.stripComponents > 0) args.push(`--strip-components=${archive.stripComponents}`);
  tar(args);
}

const stage = path.join(work, 'bundle');
await mkdir(stage, { recursive: true });

// uv first: it fetches the Python below.
console.log(`local-server bundle: uv ${pins.UV_VERSION}`);
await unpackPinned(pins.uvArchive(platform), path.join(stage, 'uv'));
const uv = path.join(stage, 'uv', exe('uv'));

// PostgreSQL, without what only building extensions needs.
const postgres = pins.postgresArchive(platform);
if (postgres) {
  console.log(`local-server bundle: PostgreSQL ${pins.POSTGRES_VERSION}`);
  const dir = path.join(stage, 'postgres');
  await unpackPinned(postgres, dir);
  for (const drop of ['include', 'lib/pkgconfig', 'lib/postgresql/pgxs', 'dist', 'scripts']) {
    await rm(path.join(dir, drop), { recursive: true, force: true });
  }
  for (const entry of await readdir(path.join(dir, 'lib'))) {
    if (entry.endsWith('.a')) await rm(path.join(dir, 'lib', entry));
  }
  // switch-core creates no extensions. initdb itself needs PL/pgSQL and the
  // Snowball dictionaries; every other module is dead weight. The Unix builds
  // keep modules in lib/postgresql and extension files in
  // share/postgresql/extension; the Windows build in lib and share/extension.
  const keepModule = (name) => /^(plpgsql|dict_snowball)\./.test(name);
  const firstDir = (...candidates) => candidates.find((candidate) => existsSync(candidate));
  const modules = firstDir(path.join(dir, 'lib', 'postgresql'), path.join(dir, 'lib'));
  for (const entry of await readdir(modules)) {
    // Windows' lib also holds import libraries (.lib), only for building.
    if (!/\.(so|dylib|dll|lib)$/.test(entry) || keepModule(entry)) continue;
    await rm(path.join(modules, entry), { recursive: true, force: true });
  }
  const extensions = firstDir(
    path.join(dir, 'share', 'postgresql', 'extension'),
    path.join(dir, 'share', 'extension')
  );
  if (!extensions) throw new Error(`No extension directory in the PostgreSQL build at ${dir}`);
  for (const entry of await readdir(extensions)) {
    if (!entry.startsWith('plpgsql')) await rm(path.join(extensions, entry));
  }
  for (const drop of ['share/doc', 'share/man', 'share/locale']) {
    await rm(path.join(dir, drop), { recursive: true, force: true });
  }
  // Recreate the shared-library links npm packaging cannot carry.
  const linksFile = path.join(dir, 'pg-symlinks.json');
  if (existsSync(linksFile)) {
    for (const { source, target } of JSON.parse(await readFile(linksFile, 'utf8'))) {
      const strip = (p) => p.replace(/^native\//, '');
      const targetPath = path.join(dir, strip(target));
      if (existsSync(targetPath)) continue;
      await symlink(
        path.relative(path.dirname(targetPath), path.join(dir, strip(source))),
        targetPath
      );
    }
  }
}

// A relocatable CPython, as uv installs it.
console.log(`local-server bundle: Python ${pins.SWITCH_CORE_PYTHON}`);
const pythons = path.join(work, 'pythons');
execFileSync(
  uv,
  ['python', 'install', pins.SWITCH_CORE_PYTHON, '--install-dir', pythons, '--no-bin'],
  {
    stdio: 'inherit',
    env: { ...process.env, UV_PYTHON_INSTALL_DIR: pythons },
  }
);
// uv adds a minor-version link beside the real directory; take the real one.
const pythonDir = (await readdir(pythons, { withFileTypes: true })).find(
  (entry) =>
    entry.isDirectory() &&
    !entry.isSymbolicLink() &&
    new RegExp(`^cpython-${pins.SWITCH_CORE_PYTHON.replace('.', '\\.')}\\.\\d+`).test(entry.name)
);
if (!pythonDir) throw new Error(`uv installed no CPython ${pins.SWITCH_CORE_PYTHON} in ${pythons}`);
await cp(path.join(pythons, pythonDir.name), path.join(stage, 'python'), {
  recursive: true,
  verbatimSymlinks: true,
});
const python =
  process.platform === 'win32'
    ? path.join(stage, 'python', 'python.exe')
    : path.join(stage, 'python', 'bin', `python${pins.SWITCH_CORE_PYTHON}`);

// switch-core: the tagged release's source, its locked requirements, and
// every one of them as a wheel.
console.log(`local-server bundle: switch-core ${switchVersion}`);
const source = path.join(work, 'source');
await mkdir(source, { recursive: true });
const tarball = path.join(work, 'switch.tar.gz');
await download(
  pins.switchSourceArchiveUrl(
    identity.RELEASE_REPO_OWNER,
    identity.RELEASE_REPO_NAME,
    switchVersion
  ),
  tarball,
  null
);
tar(['-xzf', tarball, '-C', source, '--strip-components=1']);
const switchDir = path.join(stage, 'switch');
await mkdir(path.join(switchDir, 'src', 'deploy', 'shared_resources'), { recursive: true });
await cp(path.join(source, 'core'), path.join(switchDir, 'src', 'core'), {
  recursive: true,
  filter: (p) => !p.includes(`${path.sep}tests${path.sep}`) && !p.endsWith(`${path.sep}tests`),
});
await cp(
  path.join(source, 'deploy', 'shared_resources', 'setup.py'),
  path.join(switchDir, 'src', 'deploy', 'shared_resources', 'setup.py')
);
const requirements = execFileSync(
  uv,
  ['export', '--frozen', '--no-dev', '--no-emit-project', '--format', 'requirements-txt', '-q'],
  { cwd: path.join(source, 'core'), encoding: 'utf8' }
);
const requirementsFile = path.join(work, 'requirements.txt');
await writeFile(requirementsFile, requirements);
// Installed, not as wheels: notarization inspects every compiled library in
// the app, archives included, and only a plain file can be signed with it.
// The environment made at first start reaches these through a .pth file.
execFileSync(
  uv,
  [
    'pip',
    'install',
    '--python',
    python,
    '--target',
    path.join(switchDir, 'site-packages'),
    '--require-hashes',
    '--no-compile',
    '-r',
    requirementsFile,
  ],
  { stdio: 'inherit', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }
);
// What installing switch-core itself (editable) builds with: pure-Python
// wheels, so nothing in them needs signing.
const wheels = path.join(switchDir, 'build-wheels');
const pip = (args) =>
  execFileSync(
    python,
    ['-m', 'pip', 'download', '-q', '--only-binary', ':all:', '-d', wheels, ...args],
    {
      stdio: 'inherit',
      // Nothing of pip's own may land in the Python being shipped.
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PIP_NO_CACHE_DIR: '1' },
    }
  );
pip(['hatchling', 'editables']);

// Drop what a headless server never loads: Tk, the IDE, the test suite,
// headers, man pages, and pip itself (uv installs the wheels).
const pythonRoot = path.join(stage, 'python');
const stdlib =
  process.platform === 'win32'
    ? path.join(pythonRoot, 'Lib')
    : path.join(pythonRoot, 'lib', `python${pins.SWITCH_CORE_PYTHON}`);
for (const drop of ['idlelib', 'tkinter', 'turtledemo', 'test', 'ensurepip', 'lib2to3']) {
  await rm(path.join(stdlib, drop), { recursive: true, force: true });
}
for (const entry of await readdir(path.join(stdlib, 'site-packages')).catch(() => [])) {
  if (entry.startsWith('pip')) {
    await rm(path.join(stdlib, 'site-packages', entry), { recursive: true, force: true });
  }
}
for (const drop of ['include', 'share', 'tcl', path.join('lib', 'pkgconfig')]) {
  await rm(path.join(pythonRoot, drop), { recursive: true, force: true });
}
// macOS and Linux only: on Windows `lib` is the standard library itself (the
// filesystem ignores case), where these prefixes would match `threading.py`.
const unixLib = process.platform === 'win32' ? [] : await readdir(path.join(pythonRoot, 'lib'));
for (const entry of unixLib) {
  // The interpreter is linked statically on macOS and Linux, so the shared
  // libpython beside it is only for embedding, which nothing here does.
  if (/^(tcl|tk|itcl|thread|libtcl|libtk|libpython)/.test(entry)) {
    await rm(path.join(pythonRoot, 'lib', entry), { recursive: true, force: true });
  }
}

// Prove the trimmed interpreter still runs what switch-core needs.
execFileSync(python, ['-c', 'import ssl, sqlite3, ctypes, asyncio, venv, zlib'], {
  stdio: 'inherit',
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
});

const manifest = { ...wanted, builtAt: new Date().toISOString() };
await writeFile(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

await rm(OUT, { recursive: true, force: true });
await cp(stage, OUT, { recursive: true, verbatimSymlinks: true });
await rm(work, { recursive: true, force: true });
console.log(`local-server bundle: written to ${OUT}`);
