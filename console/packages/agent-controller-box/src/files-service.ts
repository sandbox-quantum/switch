import { FilesReader, WORKSPACES_ROOT } from './files-reader';
import { ZipStop, zipBytes, zipChunks } from './files-zip';
import type { LauncherOrder, LauncherReport, ReplyCode } from './launcher-protocol';

/** The file explorer's orders, as the launcher hands them here. */
export type FilesOrder = Extract<
  LauncherOrder,
  { kind: 'files_list' | 'files_read' | 'files_zip' | 'files_more' | 'files_cancel' }
>;

/** At most this many file requests in flight, a running zip counting as one. */
export const FILES_IN_FLIGHT_MAX = 4;
export const FILES_ZIPS_MAX = 1;
/** A zip with no `files_more` for this long is dropped, and its files closed. */
export const FILES_IDLE_MS = 30_000;

type Zip = {
  chunks: AsyncGenerator<Buffer>;
  seq: number;
  pulling: boolean;
  timer: NodeJS.Timeout | null;
};

export type FilesServiceDeps = {
  report: (report: LauncherReport) => void;
  /** Fixed events with codes and counts only, never a path or a name. */
  log: (event: string, fields: Record<string, string | number>) => void;
  reader?: FilesReader;
  idleMs?: number;
};

/**
 * Serves the file explorer's orders in the launcher: one reply or chunk per
 * list and read, and a zip one chunk at a time, each after the controller's
 * `files_more`, the first unasked. A zip ends with an empty chunk marked
 * `last`. Too many requests at once answer `busy`.
 */
export class FilesService {
  private readonly reader: FilesReader;
  private readonly zips = new Map<number, Zip>();
  private inFlight = 0;

  constructor(private readonly deps: FilesServiceDeps) {
    this.reader = deps.reader ?? new FilesReader({ root: WORKSPACES_ROOT });
  }

  async handle(order: FilesOrder): Promise<void> {
    switch (order.kind) {
      case 'files_list':
        return this.once(order.id, async () => {
          const result = await this.reader.list(order.path, order.cursor);
          if (!result.ok) return this.refuse(order.id, 'list', result.code);
          this.deps.report({ kind: 'reply', id: order.id, ok: true, listing: result.listing });
        });
      case 'files_read':
        return this.once(order.id, async () => {
          const result = await this.reader.read(order.path, order.offset, order.length);
          if (!result.ok) return this.refuse(order.id, 'read', result.code);
          this.deps.report({
            kind: 'files_chunk',
            id: order.id,
            seq: 0,
            data: result.data.toString('base64'),
            last: true,
            size: result.size,
          });
        });
      case 'files_zip': {
        if (this.zips.has(order.id)) return this.refuse(order.id, 'zip', 'busy');
        if (this.inFlight >= FILES_IN_FLIGHT_MAX || this.zips.size >= FILES_ZIPS_MAX)
          return this.refuse(order.id, 'zip', 'busy');
        this.inFlight += 1;
        this.zips.set(order.id, {
          chunks: zipChunks(zipBytes(this.reader, order.path, order.includeCaches)),
          seq: 0,
          pulling: false,
          timer: null,
        });
        return this.pull(order.id);
      }
      case 'files_more':
        if (!this.zips.has(order.id)) return this.refuse(order.id, 'more', 'not_found');
        return this.pull(order.id);
      case 'files_cancel':
        await this.end(order.id);
        return;
    }
  }

  /** Every zip stopped and its files closed: the controller's link is gone. */
  async close(): Promise<void> {
    await Promise.all([...this.zips.keys()].map((id) => this.end(id)));
  }

  private async once(id: number, work: () => Promise<void>): Promise<void> {
    if (this.inFlight >= FILES_IN_FLIGHT_MAX) return this.refuse(id, 'once', 'busy');
    this.inFlight += 1;
    try {
      await work();
    } catch {
      this.refuse(id, 'once', 'failed');
    } finally {
      this.inFlight -= 1;
    }
  }

  private async pull(id: number): Promise<void> {
    const zip = this.zips.get(id);
    if (!zip || zip.pulling) return; // one chunk at a time
    zip.pulling = true;
    if (zip.timer) clearTimeout(zip.timer);
    zip.timer = null;
    let next: IteratorResult<Buffer>;
    try {
      next = await zip.chunks.next();
    } catch (error) {
      await this.end(id);
      return this.refuse(id, 'zip', error instanceof ZipStop ? error.code : 'failed');
    }
    zip.pulling = false;
    if (!this.zips.has(id)) return; // cancelled meanwhile
    const data = next.done ? '' : next.value.toString('base64');
    this.deps.report({ kind: 'files_chunk', id, seq: zip.seq, data, last: Boolean(next.done) });
    zip.seq += 1;
    if (next.done) {
      this.deps.log('files_zip_done', { chunks: zip.seq });
      await this.end(id);
      return;
    }
    zip.timer = setTimeout(() => {
      this.deps.log('files_zip_idle', { chunks: zip.seq });
      void this.end(id);
    }, this.deps.idleMs ?? FILES_IDLE_MS);
    zip.timer.unref?.();
  }

  private async end(id: number): Promise<void> {
    const zip = this.zips.get(id);
    if (!zip) return; // unknown or already ended: ignored
    this.zips.delete(id);
    this.inFlight -= 1;
    if (zip.timer) clearTimeout(zip.timer);
    await zip.chunks.return(undefined).catch(() => {});
  }

  private refuse(id: number, kind: string, code: ReplyCode): void {
    this.deps.log('files_refused', { kind, code });
    this.deps.report({ kind: 'reply', id, ok: false, code });
  }
}
