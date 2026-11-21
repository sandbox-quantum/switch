import { execFileSync } from 'node:child_process';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FILE_MAX, FilesReader } from './files-reader';

// Linux only: the reader checks every descriptor through /proc/self/fd.
const linux = process.platform === 'linux';

let dir: string;
let root: string;
let reader: FilesReader;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'files-reader-'));
  root = join(dir, 'workspaces');
  mkdirSync(root);
  // Beside the root, as on a box: per-agent state and secrets.
  mkdirSync(join(dir, 'agents', 'a1'), { recursive: true });
  writeFileSync(join(dir, 'agents', 'a1', 'credentials.json'), 'TOKEN');
  mkdirSync(join(dir, 'secrets'));
  writeFileSync(join(dir, 'secrets', 'key'), 'KEY');
  writeFileSync(join(dir, 'launcher.db'), 'DB');
  reader = new FilesReader({ root });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function file(rel: string, body = 'x'): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

const names = async (path: string, cursor?: string) => {
  const result = await reader.list(path, cursor);
  if (!result.ok) throw new Error(result.code);
  return result.listing;
};

describe.runIf(linux)('paths', () => {
  it.each(['..', '../agents', '/etc/passwd', 'a/../b', 'a//b', 'a/', './a', 'a\\b', 'a\u0000b'])(
    'refuses %j as outside the root',
    async (path) => {
      expect(await reader.read(path, 0, 10)).toEqual({ ok: false, code: 'outside_root' });
    }
  );

  it('reads a file inside the root, by range, with its size', async () => {
    file('agent-a/notes.md', 'hello world');
    expect(await reader.read('agent-a/notes.md', 6, 100)).toMatchObject({ ok: true, size: 11 });
    const result = await reader.read('agent-a/notes.md', 6, 100);
    expect(result.ok && result.data.toString()).toBe('world');
    const past = await reader.read('agent-a/notes.md', 50, 10);
    expect(past.ok && past.data.length).toBe(0);
  });

  it('answers not_found for nothing there', async () => {
    expect(await reader.read('nope.txt', 0, 1)).toEqual({ ok: false, code: 'not_found' });
  });

  it('refuses a file over 25 MB', async () => {
    file('big.bin');
    truncateSync(join(root, 'big.bin'), FILE_MAX + 1);
    expect(await reader.read('big.bin', 0, 1)).toEqual({ ok: false, code: 'too_large' });
  });

  it('refuses to open anything when /proc/self/fd is not there', async () => {
    file('a.txt');
    const blind = new FilesReader({ root, procFd: join(dir, 'no-proc') });
    expect(await blind.read('a.txt', 0, 1)).toEqual({ ok: false, code: 'failed' });
  });
});

describe.runIf(linux)('the deny list, at any depth', () => {
  const denied = [
    'credentials.json',
    '.cache',
    '.tmp',
    '.retired',
    '.ssh',
    '.git-credentials',
    '.netrc',
    '.npmrc',
    '.pypirc',
    '.claude',
    '.codex',
    '.aws',
    'provider-home',
    'provider-data',
    'google-credentials.json',
    'application_default_credentials.json',
    'auth.json',
    'acp_token.json',
    '.gemini',
    '.cursor',
    '.opencode',
    'agent.switch-credential',
    'x.switch-new',
  ];

  it.each(denied)('%s at depth 1 and 5: left out of listings and refused', async (name) => {
    for (const at of ['', 'a/b/c/d/']) {
      file(`${at}${name}`, 'SECRET');
      file(`${at}kept.txt`);
      const listing = await names(at.replace(/\/$/, ''));
      expect(listing.entries.map((e) => e.name)).toEqual(['kept.txt']);
      expect(await reader.read(`${at}${name}`, 0, 10)).toEqual({ ok: false, code: 'denied' });
    }
  });

  it('refuses what is inside a denied folder', async () => {
    file('proj/.ssh/id_ed25519', 'KEY');
    expect(await reader.read('proj/.ssh/id_ed25519', 0, 10)).toEqual({ ok: false, code: 'denied' });
  });

  it.each(['gh', 'gcloud'])('refuses .config/%s but not other .config folders', async (name) => {
    file(`proj/.config/${name}/hosts.yml`, 'TOKEN');
    file('proj/.config/other/ok.txt');
    expect((await names('proj/.config')).entries.map((e) => e.name)).toEqual(['other']);
    expect(await reader.read(`proj/.config/${name}/hosts.yml`, 0, 10)).toEqual({
      ok: false,
      code: 'denied',
    });
  });
});

describe.runIf(linux)('links', () => {
  it('follows a link that stays inside the root', async () => {
    file('shared/site/index.html', '<p>hi</p>');
    symlinkSync(join(root, 'shared/site'), join(root, 'site-link'));
    const result = await reader.read('site-link/index.html', 0, 100);
    expect(result.ok && result.data.toString()).toBe('<p>hi</p>');
    expect((await names('')).entries.find((e) => e.name === 'site-link')).toMatchObject({
      kind: 'folder',
    });
  });

  it.each([
    ['a credentials file, absolute', () => join(dir, 'agents', 'a1', 'credentials.json')],
    ['a credentials file, relative', () => '../agents/a1/credentials.json'],
    ['the secrets folder', () => join(dir, 'secrets')],
    ['the launcher database', () => join(dir, 'launcher.db')],
    ['the controller data', () => '/data/controller'],
    ['the system', () => '/etc/passwd'],
  ])('refuses a link to %s, and leaves it out of listings', async (_name, target) => {
    symlinkSync(target(), join(root, 'leak'));
    file('kept.txt');
    expect((await names('')).entries.map((e) => e.name)).toEqual(['kept.txt']);
    expect(['outside_root', 'not_found']).toContain(
      ((await reader.read('leak', 0, 10)) as { code: string }).code
    );
    expect(['outside_root', 'not_found']).toContain(
      ((await reader.list('leak')) as { code: string }).code
    );
  });

  it('refuses a link inside the root to something denied', async () => {
    file('proj/.ssh/key', 'KEY');
    symlinkSync(join(root, 'proj/.ssh/key'), join(root, 'innocent.txt'));
    // Each layer on its own: the real path checked before opening, then the descriptor's.
    expect(await reader.resolve('innocent.txt')).toEqual({ ok: false, code: 'denied' });
    expect(await reader.read('innocent.txt', 0, 10)).toEqual({ ok: false, code: 'denied' });
    expect((await names('')).entries.map((e) => e.name)).toEqual(['proj']);
  });

  it('catches a file swapped for a link after the check', async () => {
    file('a.txt', 'fine');
    const resolved = await reader.resolve('a.txt');
    if (!resolved.ok) throw new Error('resolve');
    rmSync(join(root, 'a.txt'));
    symlinkSync(join(dir, 'secrets', 'key'), join(root, 'a.txt'));
    expect(await reader.openReal(resolved.real, resolved.rootReal, 'file')).toEqual({
      ok: false,
      code: 'outside_root',
    });
  });

  it('catches a parent folder swapped for a link after the check', async () => {
    file('proj/key', 'fine');
    const resolved = await reader.resolve('proj/key');
    if (!resolved.ok) throw new Error('resolve');
    renameSync(join(root, 'proj'), join(root, 'proj-old'));
    symlinkSync(join(dir, 'secrets'), join(root, 'proj'));
    expect(await reader.openReal(resolved.real, resolved.rootReal, 'file')).toEqual({
      ok: false,
      code: 'outside_root',
    });
  });
});

describe.runIf(linux)('things that are not files or folders', () => {
  let server: Server | null = null;
  afterEach(() => server?.close());

  it('refuses a pipe without hanging, and leaves it out of listings', async () => {
    execFileSync('mkfifo', [join(root, 'pipe')]);
    file('kept.txt');
    const started = Date.now();
    expect(await reader.read('pipe', 0, 10)).toEqual({ ok: false, code: 'not_regular' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect((await names('')).entries.map((e) => e.name)).toEqual(['kept.txt']);
  });

  it('refuses a socket', async () => {
    server = createServer();
    await new Promise<void>((resolve) => server!.listen(join(root, 'sock'), resolve));
    expect(await reader.read('sock', 0, 10)).toEqual({ ok: false, code: 'not_regular' });
  });

  it('refuses a folder asked for as a file, and a file asked for as a folder', async () => {
    file('d/f.txt');
    expect(await reader.read('d', 0, 10)).toEqual({ ok: false, code: 'not_regular' });
    expect(await reader.list('d/f.txt')).toEqual({ ok: false, code: 'not_regular' });
  });
});

describe.runIf(linux)('listing', () => {
  it('pages 2,500 entries in sorted pages of 1,000 with a stable cursor', async () => {
    for (let i = 0; i < 2500; i++) file(`big/f${String(i).padStart(4, '0')}`);
    const first = await names('big');
    expect(first.entries).toHaveLength(1000);
    expect(first.cursor).toBe('f0999');
    const second = await names('big', first.cursor);
    expect(second.entries[0]!.name).toBe('f1000');
    const third = await names('big', second.cursor);
    expect(third.entries).toHaveLength(500);
    expect(third.cursor).toBeUndefined();
  });

  it('marks cache folders collapsed, and not dist or build', async () => {
    for (const name of ['node_modules', '.git', '__pycache__', '.venv', 'dist', 'build'])
      file(`proj/${name}/x`);
    file('proj/.next/cache/x');
    file('proj/.next/server/x');
    const listing = await names('proj');
    const collapsed = listing.entries.filter((e) => e.collapsed).map((e) => e.name);
    expect(collapsed.sort()).toEqual(['.git', '.venv', '__pycache__', 'node_modules']);
    const next = await names('proj/.next');
    expect(next.entries.find((e) => e.name === 'cache')?.collapsed).toBe(true);
    expect(next.entries.find((e) => e.name === 'server')?.collapsed).toBeUndefined();
  });

  it('gives each entry its kind, size and time', async () => {
    file('proj/a.txt', 'abc');
    const [entry] = (await names('proj')).entries;
    expect(entry).toMatchObject({ name: 'a.txt', kind: 'file', size: 3 });
    expect(entry!.mtime).toBeGreaterThan(0);
  });
});

describe.runIf(linux)('hard links to known secrets', () => {
  let guarded: FilesReader;
  beforeEach(() => {
    mkdirSync(join(dir, 'watchers', 'a1', 'provider-home'), { recursive: true });
    writeFileSync(join(dir, 'watchers', 'a1', 'provider-home', 'google-credentials.json'), 'SA');
    writeFileSync(join(dir, 'controller.db'), 'DB');
    guarded = new FilesReader({ root, dataRoot: dir, secretsRefreshMs: 0 });
  });

  it.each([
    ['a credentials file', 'agents/a1/credentials.json'],
    ['a file in secrets', 'secrets/key'],
    ['a provider login', 'watchers/a1/provider-home/google-credentials.json'],
    ['the launcher database', 'controller.db'],
  ])('refuses a hard link to %s in a read and leaves it out of a zip', async (_name, secret) => {
    file('proj/keep.txt', 'ok');
    linkSync(join(dir, secret), join(root, 'proj', 'innocent.txt'));
    expect(await guarded.read('proj/innocent.txt', 0, 10)).toEqual({ ok: false, code: 'denied' });
    const { zipBytes } = await import('./files-zip');
    const parts: Buffer[] = [];
    for await (const piece of zipBytes(guarded, 'proj', false)) parts.push(piece);
    const zip = Buffer.concat(parts);
    expect(zip.includes(Buffer.from('innocent.txt'))).toBe(false);
    expect(zip.includes(Buffer.from('keep.txt'))).toBe(true);
  });

  it('still reads a pnpm-style hard-linked node_modules file', async () => {
    file('proj/.pnpm-store/pkg/index.js', 'module.exports = 1');
    mkdirSync(join(root, 'proj', 'node_modules', 'pkg'), { recursive: true });
    linkSync(
      join(root, 'proj/.pnpm-store/pkg/index.js'),
      join(root, 'proj/node_modules/pkg/index.js')
    );
    const result = await guarded.read('proj/node_modules/pkg/index.js', 0, 100);
    expect(result.ok && result.data.toString()).toBe('module.exports = 1');
  });

  it('knows a secret written after it started, once the set is rebuilt', async () => {
    file('proj/early.txt', 'ok');
    expect((await guarded.read('proj/early.txt', 0, 10)).ok).toBe(true); // builds the set
    mkdirSync(join(dir, 'agents', 'a2'));
    writeFileSync(join(dir, 'agents', 'a2', 'credentials.json'), 'NEW');
    linkSync(join(dir, 'agents', 'a2', 'credentials.json'), join(root, 'proj', 'late.txt'));
    expect(await guarded.read('proj/late.txt', 0, 10)).toEqual({ ok: false, code: 'denied' });
  });

  it('rebuilds at most once a refresh period', async () => {
    let now = 0;
    const slow = new FilesReader({ root, dataRoot: dir, secretsRefreshMs: 60_000, now: () => now });
    file('proj/a.txt', 'ok');
    expect((await slow.read('proj/a.txt', 0, 10)).ok).toBe(true);
    mkdirSync(join(dir, 'agents', 'a3'));
    writeFileSync(join(dir, 'agents', 'a3', 'credentials.json'), 'NEW');
    linkSync(join(dir, 'agents', 'a3', 'credentials.json'), join(root, 'proj', 'late.txt'));
    expect((await slow.read('proj/late.txt', 0, 10)).ok).toBe(true); // not yet known
    now = 60_000;
    expect(await slow.read('proj/late.txt', 0, 10)).toEqual({ ok: false, code: 'denied' });
  });
});
