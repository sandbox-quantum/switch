import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilesReader } from './files-reader';
import { FilesService } from './files-service';
import { ZIP_ENTRIES_MAX, ZipStop, zipBytes, zipChunks } from './files-zip';
import { FILES_CHUNK_MAX, type LauncherReport } from './launcher-protocol';

const linux = process.platform === 'linux';

let dir: string;
let root: string;
let reader: FilesReader;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'files-zip-'));
  root = join(dir, 'workspaces');
  mkdirSync(root);
  mkdirSync(join(dir, 'secrets'));
  writeFileSync(join(dir, 'secrets', 'key'), 'KEY');
  reader = new FilesReader({ root });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function file(rel: string, body: string | Buffer = 'x'): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

async function zipOf(
  path: string,
  includeCaches = false,
  cap?: number,
  entriesCap?: number
): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const piece of zipBytes(reader, path, includeCaches, cap, entriesCap))
    parts.push(piece);
  return Buffer.concat(parts);
}

/** What Python's zipfile makes of it: each name and its bytes, after a CRC check of every entry. */
function unzip(zip: Buffer): Record<string, string> {
  const at = join(dir, 'out.zip');
  writeFileSync(at, zip);
  const script = [
    'import json, sys, zipfile',
    'z = zipfile.ZipFile(sys.argv[1])',
    'assert z.testzip() is None',
    'print(json.dumps({i.filename: z.read(i).decode("latin-1") for i in z.infolist()}))',
  ].join('\n');
  return JSON.parse(
    execFileSync('python3', ['-c', script, at], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  ) as Record<string, string>;
}

describe.runIf(linux)('the zip', () => {
  it('holds every readable file byte for byte, with plain relative names', async () => {
    const big = Buffer.alloc(300_000, 7);
    file('proj/index.html', '<p>hi</p>');
    file('proj/src/app.ts', 'export {}');
    file('proj/assets/big.bin', big);
    file('proj/ünï.txt', 'utf8 name');
    const entries = unzip(await zipOf('proj'));
    expect(entries['index.html']).toBe('<p>hi</p>');
    expect(entries['src/app.ts']).toBe('export {}');
    expect(entries['ünï.txt']).toBe('utf8 name');
    expect(Buffer.from(entries['assets/big.bin']!, 'latin1').equals(big)).toBe(true);
    for (const name of Object.keys(entries)) {
      expect(name.startsWith('/')).toBe(false);
      expect(name.split('/')).not.toContain('..');
    }
  });

  it('leaves out links, denied names and caches, unless caches are asked for', async () => {
    file('proj/keep.txt');
    file('proj/.ssh/id', 'KEY');
    file('proj/credentials.json', 'TOKEN');
    file('proj/node_modules/pkg/index.js', 'cache');
    file('proj/.next/cache/a', 'cache');
    symlinkSync(join(dir, 'secrets'), join(root, 'proj', 'out-link'));
    symlinkSync(join(root, 'proj', 'keep.txt'), join(root, 'proj', 'in-link'));
    execFileSync('mkfifo', [join(root, 'proj', 'pipe')]);
    const plain = Object.keys(unzip(await zipOf('proj'))).sort();
    expect(plain).toEqual(['.next/', 'keep.txt']);
    const all = Object.keys(unzip(await zipOf('proj', true))).sort();
    expect(all).toEqual([
      '.next/',
      '.next/cache/',
      '.next/cache/a',
      'keep.txt',
      'node_modules/',
      'node_modules/pkg/',
      'node_modules/pkg/index.js',
    ]);
  });

  it('stops with too_large past the cap', async () => {
    file('proj/a.bin', Buffer.alloc(800));
    file('proj/b.bin', Buffer.alloc(800));
    await expect(zipOf('proj', false, 1000)).rejects.toEqual(new ZipStop('too_large'));
  });

  it('stops with too_large past the entry cap, however small the files', async () => {
    for (let i = 0; i < 12; i++) file(`many/e${i}`, '');
    await expect(zipOf('many', false, undefined, 10)).rejects.toEqual(new ZipStop('too_large'));
    expect(Object.keys(unzip(await zipOf('many', false, undefined, 12)))).toHaveLength(12);
  });

  it('holds its entry cap under the most a zip can count without ZIP64', () => {
    expect(ZIP_ENTRIES_MAX).toBeLessThan(0xffff);
  });

  it('refuses a folder outside the root or denied, before any byte', async () => {
    symlinkSync(join(dir, 'secrets'), join(root, 'leak'));
    file('proj/.aws/config');
    await expect(zipOf('leak')).rejects.toBeInstanceOf(ZipStop);
    await expect(zipOf('proj/.aws')).rejects.toEqual(new ZipStop('denied'));
  });

  it('regroups into full chunks of 128 KiB, the last short', async () => {
    async function* pieces() {
      for (let i = 0; i < 10; i++) yield Buffer.alloc(50_000, i);
    }
    const sizes: number[] = [];
    for await (const chunk of zipChunks(pieces())) sizes.push(chunk.length);
    expect(sizes).toEqual([
      FILES_CHUNK_MAX,
      FILES_CHUNK_MAX,
      FILES_CHUNK_MAX,
      500_000 - 3 * FILES_CHUNK_MAX,
    ]);
  });
});

describe.runIf(linux)('the service', () => {
  function service(idleMs?: number) {
    const reports: LauncherReport[] = [];
    const logs: Array<[string, Record<string, string | number>]> = [];
    const files = new FilesService({
      reader,
      report: (report) => reports.push(report),
      log: (event, fields) => logs.push([event, fields]),
      ...(idleMs ? { idleMs } : {}),
    });
    return { files, reports, logs };
  }

  it('answers a list with a reply and a read with one last chunk', async () => {
    file('a/b.txt', 'hello');
    const { files, reports } = service();
    await files.handle({ kind: 'files_list', id: 1, path: 'a' });
    await files.handle({ kind: 'files_read', id: 2, path: 'a/b.txt', offset: 0, length: 5 });
    expect(reports[0]).toMatchObject({ kind: 'reply', id: 1, ok: true });
    expect(reports[1]).toEqual({
      kind: 'files_chunk',
      id: 2,
      seq: 0,
      data: Buffer.from('hello').toString('base64'),
      last: true,
      size: 5,
    });
  });

  it('sends a zip one chunk per files_more, ending with an empty last chunk', async () => {
    file('proj/big.bin', Buffer.alloc(400_000, 1));
    const { files, reports } = service();
    await files.handle({ kind: 'files_zip', id: 9, path: 'proj', includeCaches: false });
    expect(reports).toHaveLength(1); // the first, unasked
    for (let i = 0; i < 20 && !(reports.at(-1) as { last?: boolean }).last; i++)
      await files.handle({ kind: 'files_more', id: 9 });
    const chunks = reports as Array<Extract<LauncherReport, { kind: 'files_chunk' }>>;
    expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_, i) => i));
    expect(chunks.at(-1)).toMatchObject({ last: true, data: '' });
    const zip = Buffer.concat(chunks.map((c) => Buffer.from(c.data, 'base64')));
    expect(Buffer.from(unzip(zip)['big.bin']!, 'latin1').length).toBe(400_000);
    // Done: a later files_more is for an unknown zip.
    await files.handle({ kind: 'files_more', id: 9 });
    expect(reports.at(-1)).toEqual({ kind: 'reply', id: 9, ok: false, code: 'not_found' });
  });

  it('answers busy past one zip at a time', async () => {
    file('proj/a.txt');
    const { files, reports } = service();
    await files.handle({ kind: 'files_zip', id: 1, path: 'proj', includeCaches: false });
    await files.handle({ kind: 'files_zip', id: 2, path: 'proj', includeCaches: false });
    expect(reports.at(-1)).toEqual({ kind: 'reply', id: 2, ok: false, code: 'busy' });
    await files.handle({ kind: 'files_cancel', id: 1 });
    await files.handle({ kind: 'files_zip', id: 3, path: 'proj', includeCaches: false });
    expect(reports.at(-1)).toMatchObject({ kind: 'files_chunk', id: 3, seq: 0 });
    await files.close();
  });

  it('answers busy past four requests in flight', async () => {
    for (let i = 0; i < 5; i++) file(`d${i}/f`);
    const { files, reports } = service();
    await Promise.all(
      [0, 1, 2, 3, 4].map((i) => files.handle({ kind: 'files_list', id: i, path: `d${i}` }))
    );
    const busy = reports.filter((r) => r.kind === 'reply' && r.code === 'busy');
    expect(busy).toHaveLength(1);
  });

  it('drops a zip nobody asks more of, and ignores an unknown cancel', async () => {
    file('proj/big.bin', Buffer.alloc(400_000, 1));
    const { files, reports, logs } = service(50);
    await files.handle({ kind: 'files_zip', id: 4, path: 'proj', includeCaches: false });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(logs.map(([event]) => event)).toContain('files_zip_idle');
    await files.handle({ kind: 'files_more', id: 4 });
    expect(reports.at(-1)).toEqual({ kind: 'reply', id: 4, ok: false, code: 'not_found' });
    await files.handle({ kind: 'files_cancel', id: 404 });
  });

  it('never logs a path or a name', async () => {
    file('secret-project/.ssh/id', 'KEY');
    const { files, logs } = service();
    await files.handle({
      kind: 'files_read',
      id: 1,
      path: 'secret-project/.ssh/id',
      offset: 0,
      length: 1,
    });
    await files.handle({ kind: 'files_list', id: 2, path: 'no-such-folder' });
    await files.handle({ kind: 'files_zip', id: 3, path: 'secret-project', includeCaches: false });
    const text = JSON.stringify(logs);
    expect(text).not.toContain('secret-project');
    expect(text).not.toContain('no-such-folder');
    expect(text).not.toContain('.ssh');
    await files.close();
  });
});
