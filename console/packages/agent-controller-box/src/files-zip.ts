import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflateRaw, crc32 } from 'node:zlib';
import { cacheName, deniedName, type FilesReader, type Refusal } from './files-reader';
import { FILES_CHUNK_MAX } from './launcher-protocol';

/**
 * A folder under the workspaces folder as a zip, made as it is read, in
 * chunks of at most `FILES_CHUNK_MAX` for the launcher link.
 *
 * It walks with `lstat` and never follows a link: links, devices, pipes and
 * sockets are left out, and so is every never-readable name. Cache folders are
 * left out unless `includeCaches`. Each file and folder is opened through the
 * reader's checks, so the root, the deny list and the descriptor recheck all
 * apply. Entry names are built only from those checked plain names, relative,
 * so an unzip can't write outside its folder.
 *
 * File bytes past `ZIP_TOTAL_MAX`, or more than `ZIP_ENTRIES_MAX` files and
 * folders, stop it with `too_large`.
 */

export const ZIP_TOTAL_MAX = 500 * 1024 * 1024;
/** How deep a folder walk goes before `too_large`. */
export const ZIP_DEPTH_MAX = 64;
/** How many names the walk looks at, kept or not, before `too_large`: a bound on its time. */
export const ZIP_NAMES_MAX = 200_000;
/**
 * How many files and folders one zip holds before `too_large`, checked as each
 * is added, so a folder of millions of empty files never builds a huge
 * directory in memory. Below 65,535, the most a zip holds without ZIP64.
 */
export const ZIP_ENTRIES_MAX = 65_000;

export class ZipStop extends Error {
  constructor(readonly code: Refusal['code']) {
    super(code);
  }
}

type Central = {
  name: Buffer;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
  dos: number;
  folder: boolean;
};

function dosTime(ms: number): number {
  const d = new Date(Math.max(ms, Date.UTC(1980, 0, 1)));
  const time =
    (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2);
  const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return ((date << 16) | time) >>> 0;
}

const UTF8 = 0x0800;
const DESCRIPTOR = 0x0008;

function localHeader(name: Buffer, dos: number, folder: boolean): Buffer {
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(UTF8 | (folder ? 0 : DESCRIPTOR), 6);
  head.writeUInt16LE(folder ? 0 : 8, 8); // deflate for files
  head.writeUInt32LE(dos, 10);
  // crc and sizes: zero here, in the data descriptor after the data
  head.writeUInt16LE(name.length, 26);
  head.writeUInt16LE(0, 28);
  return Buffer.concat([head, name]);
}

function dataDescriptor(crc: number, compressed: number, size: number): Buffer {
  const out = Buffer.alloc(16);
  out.writeUInt32LE(0x08074b50, 0);
  out.writeUInt32LE(crc >>> 0, 4);
  out.writeUInt32LE(compressed, 8);
  out.writeUInt32LE(size, 12);
  return out;
}

function centralRecord(entry: Central): Buffer {
  const head = Buffer.alloc(46);
  head.writeUInt32LE(0x02014b50, 0);
  head.writeUInt16LE(0x0314, 4); // made by: Unix, 2.0
  head.writeUInt16LE(20, 6);
  head.writeUInt16LE(UTF8 | (entry.folder ? 0 : DESCRIPTOR), 8);
  head.writeUInt16LE(entry.folder ? 0 : 8, 10);
  head.writeUInt32LE(entry.dos, 12);
  head.writeUInt32LE(entry.crc >>> 0, 16);
  head.writeUInt32LE(entry.compressed, 20);
  head.writeUInt32LE(entry.size, 24);
  head.writeUInt16LE(entry.name.length, 28);
  // extra, comment, disk: 0; internal attributes: 0
  const mode = entry.folder ? 0o040755 : 0o100644; // plain modes only: no links, no setuid
  head.writeUInt32LE(((mode << 16) | (entry.folder ? 0x10 : 0)) >>> 0, 38);
  head.writeUInt32LE(entry.offset, 42);
  return Buffer.concat([head, entry.name]);
}

function endRecord(count: number, size: number, offset: number): Buffer {
  const out = Buffer.alloc(22);
  out.writeUInt32LE(0x06054b50, 0);
  out.writeUInt16LE(count, 8);
  out.writeUInt16LE(count, 10);
  out.writeUInt32LE(size, 12);
  out.writeUInt32LE(offset, 16);
  return out;
}

/**
 * The zip's bytes, as they are made. Throws `ZipStop` with a code when the
 * folder can't be zipped or the cap is hit.
 */
export async function* zipBytes(
  reader: FilesReader,
  path: string,
  includeCaches: boolean,
  cap = ZIP_TOTAL_MAX,
  entriesCap = ZIP_ENTRIES_MAX
): AsyncGenerator<Buffer> {
  const top = await reader.openChecked(path, 'folder');
  if (!top.ok) throw new ZipStop(top.code);
  await top.handle.close();
  const resolved = await reader.resolve(path);
  if (!resolved.ok) throw new ZipStop(resolved.code);
  const { rootReal } = resolved;

  const central: Central[] = [];
  let offset = 0;
  let total = 0;
  let looked = 0;

  async function* folder(real: string, prefix: string[], depth: number): AsyncGenerator<Buffer> {
    if (depth > ZIP_DEPTH_MAX) throw new ZipStop('too_large');
    const opened = await reader.openReal(real, rootReal, 'folder');
    if (!opened.ok) return; // changed since it was listed: left out
    let names: string[];
    const parent = opened.parts.at(-1);
    try {
      names = (await readdir(reader.fdPath(opened.handle))).sort();
    } finally {
      await opened.handle.close().catch(() => {});
    }
    for (const name of names) {
      if (deniedName(name, parent)) continue;
      if (++looked > ZIP_NAMES_MAX) throw new ZipStop('too_large');
      const child = join(real, name);
      let info;
      try {
        info = await lstat(child);
      } catch {
        continue;
      }
      const parts = [...prefix, name];
      if (info.isDirectory()) {
        if (!includeCaches && cacheName(name, parent)) continue;
        yield* entry(parts, Math.floor(info.mtimeMs), true);
        yield* folder(child, parts, depth + 1);
      } else if (info.isFile()) {
        yield* file(child, parts);
      }
      // links, devices, pipes and sockets: left out
    }
  }

  async function* entry(parts: string[], mtime: number, isFolder: boolean): AsyncGenerator<Buffer> {
    const name = Buffer.from(parts.join('/') + (isFolder ? '/' : ''), 'utf8');
    const dos = dosTime(mtime);
    const head = localHeader(name, dos, isFolder);
    if (central.length >= entriesCap) throw new ZipStop('too_large');
    central.push({ name, crc: 0, compressed: 0, size: 0, offset, dos, folder: isFolder });
    offset += head.length;
    yield head;
  }

  async function* file(real: string, parts: string[]): AsyncGenerator<Buffer> {
    const opened = await reader.openReal(real, rootReal, 'file');
    if (!opened.ok) return;
    try {
      if (total + opened.size > cap) throw new ZipStop('too_large');
      yield* entry(parts, opened.mtime, false);
      const record = central[central.length - 1]!;
      let crc = 0;
      let size = 0;
      let compressed = 0;
      const tap = new Transform({
        transform(data: Buffer, _encoding, done) {
          size += data.length;
          if (total + size > cap) return done(new ZipStop('too_large'));
          crc = crc32(data, crc);
          done(null, data);
        },
      });
      const deflate = createDeflateRaw();
      // Consumed below as it is made, so the pipeline never holds more than its buffers.
      const running = pipeline(
        opened.handle.createReadStream({ start: 0, autoClose: false }),
        tap,
        deflate
      );
      running.catch(() => {}); // seen below; never left unhandled if the walk stops early
      for await (const out of deflate as AsyncIterable<Buffer>) {
        compressed += out.length;
        yield out;
      }
      await running;
      total += size;
      record.crc = crc;
      record.compressed = compressed;
      record.size = size;
      const tail = dataDescriptor(crc, compressed, size);
      offset += compressed + tail.length;
      yield tail;
    } finally {
      await opened.handle.close().catch(() => {});
    }
  }

  yield* folder(resolved.real, [], 0);
  const start = offset;
  let size = 0;
  for (const record of central) {
    const out = centralRecord(record);
    size += out.length;
    yield out;
  }
  yield endRecord(central.length, size, start);
}

/** `zipBytes` regrouped into chunks of at most `FILES_CHUNK_MAX`, each but the last full. */
export async function* zipChunks(bytes: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  let held: Buffer[] = [];
  let heldBytes = 0;
  for await (const piece of bytes) {
    let rest = piece;
    while (heldBytes + rest.length >= FILES_CHUNK_MAX) {
      const take = FILES_CHUNK_MAX - heldBytes;
      held.push(rest.subarray(0, take));
      yield Buffer.concat(held);
      held = [];
      heldBytes = 0;
      rest = rest.subarray(take);
    }
    if (rest.length > 0) {
      held.push(rest);
      heldBytes += rest.length;
    }
  }
  if (heldBytes > 0) yield Buffer.concat(held);
}
