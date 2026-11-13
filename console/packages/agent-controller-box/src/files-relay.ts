import { agentFor, type FolderLabel, labelFor } from './file-labels';
import {
  errorReply,
  FILES_CHUNK_BYTES,
  type FilesErrorCode,
  type FilesReply,
  type FilesRequest,
} from './files-frames';
import type { FileReport } from './launcher-link';
import { launcherOrderSchema, type ReplyCode } from './launcher-protocol';

/** At most this many file requests at once per box, so a big zip can't starve agent traffic. */
export const FILES_RELAY_IN_FLIGHT = 4;
/** How long a list or read may take, end to end. */
export const FILES_ONCE_DEADLINE_MS = 30_000;
/** How long a whole zip may take. */
export const FILES_ZIP_DEADLINE_MS = 10 * 60_000;

/** The launcher link, as the relay uses it (`LauncherLink`'s file methods). */
export type FilesLink = {
  startFile(
    order:
      | { kind: 'files_list'; path: string; cursor?: string }
      | { kind: 'files_read'; path: string; offset: number; length: number }
      | { kind: 'files_zip'; path: string; includeCaches: boolean },
    onReport: (report: FileReport) => void
  ): number;
  followFile(kind: 'files_more' | 'files_cancel', id: number): void;
  endFile(id: number): void;
};

export type FilesRelayDeps = {
  link: FilesLink;
  /** Sends a reply up the controller's socket to Core. */
  send: (reply: FilesReply) => void;
  /** Top-level folder labels from the controller's own agent definitions (`topLevelLabels`). */
  labels: () => ReadonlyMap<string, FolderLabel>;
  /**
   * A hook for box activity, if the controller ever reports it itself. Today Core
   * marks the box active when it serves the request (`active_at`), as it does for
   * a message, so the controller passes none.
   */
  activity?: () => void;
  /** Fixed events with codes and counts only: never a path or a name. */
  log: (event: string, fields: Record<string, string | number>) => void;
  onceDeadlineMs?: number;
  zipDeadlineMs?: number;
};

type Open = {
  launcherId: number;
  op: FilesRequest['op'];
  topLevel: boolean;
  seq: number;
  /** A zip chunk was sent on and the next isn't asked for yet. */
  awaitingMore: boolean;
  timer: NodeJS.Timeout;
  startedAt: number;
  bytes: number;
};

/**
 * The file explorer's relay in the controller (file explorer plan, controller
 * part). A request from Core becomes one launcher order; the launcher's
 * replies and chunks go back to Core as `files.reply` frames under Core's id,
 * one launcher chunk each (128 KiB at most). The controller never opens a file:
 * the launcher reads, as the agents' own user. It labels top-level folders from
 * its own agent definitions, limits requests in flight, keeps each request's
 * deadline, passes zip chunks on one at a time (the next asked for only after
 * Core asks), and logs codes and counts only. A file request never starts an
 * agent host; it counts as box activity.
 */
export class FilesRelay {
  private readonly open = new Map<string, Open>();

  constructor(private readonly deps: FilesRelayDeps) {}

  get inFlight(): number {
    return this.open.size;
  }

  request(frame: FilesRequest): void {
    if (this.open.has(frame.id)) return this.refuse(frame.id, 0, 'busy');
    if (this.open.size >= FILES_RELAY_IN_FLIGHT) return this.refuse(frame.id, 0, 'busy');
    const order =
      frame.op === 'list'
        ? {
            kind: 'files_list' as const,
            path: frame.path,
            ...(frame.cursor ? { cursor: frame.cursor } : {}),
          }
        : frame.op === 'read'
          ? {
              kind: 'files_read' as const,
              path: frame.path,
              offset: frame.offset ?? 0,
              length: frame.length ?? FILES_CHUNK_BYTES,
            }
          : { kind: 'files_zip' as const, path: frame.path, includeCaches: frame.caches ?? false };
    // The launcher's own schema, before anything is sent: an order it would refuse
    // as a malformed line would otherwise only time out.
    if (!launcherOrderSchema.safeParse({ ...order, id: 1 }).success)
      return this.refuse(frame.id, 0, 'not_found');
    this.deps.activity?.();
    const deadline =
      frame.op === 'zip'
        ? (this.deps.zipDeadlineMs ?? FILES_ZIP_DEADLINE_MS)
        : (this.deps.onceDeadlineMs ?? FILES_ONCE_DEADLINE_MS);
    const timer = setTimeout(() => this.expire(frame.id), deadline);
    timer.unref?.();
    const open: Open = {
      launcherId: 0,
      op: frame.op,
      topLevel: frame.path === '',
      seq: 0,
      awaitingMore: false,
      timer,
      startedAt: Date.now(),
      bytes: 0,
    };
    this.open.set(frame.id, open);
    open.launcherId = this.deps.link.startFile(order, (report) => this.report(frame.id, report));
  }

  /** Core asks for the next zip chunk. */
  more(id: string): void {
    const open = this.open.get(id);
    if (!open || open.op !== 'zip' || !open.awaitingMore) return;
    open.awaitingMore = false;
    this.deps.activity?.();
    this.deps.link.followFile('files_more', open.launcherId);
  }

  /** Core's side went away: stop at the launcher, and send nothing more. */
  cancel(id: string): void {
    const open = this.open.get(id);
    if (!open) return;
    this.deps.link.followFile('files_cancel', open.launcherId);
    this.finish(id, 'cancelled');
  }

  /** The controller's socket to Core is gone: every request ends at the launcher. */
  cancelAll(): void {
    for (const id of [...this.open.keys()]) this.cancel(id);
  }

  private report(id: string, report: FileReport): void {
    const open = this.open.get(id);
    if (!open) return;
    if (report.kind === 'reply') {
      if (!report.ok) return this.refuse(id, open.seq, codeFor(report.code), open);
      if (open.op !== 'list' || !report.listing) return this.refuse(id, open.seq, 'failed', open);
      const labels = open.topLevel ? this.deps.labels() : null;
      const entries = report.listing.entries.map((entry) =>
        labels && entry.kind === 'folder'
          ? {
              ...entry,
              label: labelFor(labels, entry.name),
              ...(agentFor(labels, entry.name) ? { agent: agentFor(labels, entry.name) } : {}),
            }
          : entry
      );
      this.deps.send({
        type: 'files.reply',
        id,
        seq: open.seq,
        last: true,
        entries,
        ...(report.listing.cursor ? { cursor: report.listing.cursor } : {}),
      });
      return this.finish(id, 'ok');
    }
    // A chunk: passed on as it came (the launcher's schema already bounds it), under Core's id.
    if (open.op === 'list') return this.refuse(id, open.seq, 'failed', open);
    open.bytes += Math.floor((report.data.length * 3) / 4);
    this.deps.send({
      type: 'files.reply',
      id,
      seq: open.seq,
      last: report.last,
      data: report.data,
      ...(report.size === undefined ? {} : { size: report.size }),
    });
    open.seq += 1;
    if (report.last || open.op === 'read') return this.finish(id, 'ok');
    open.awaitingMore = true;
  }

  private expire(id: string): void {
    const open = this.open.get(id);
    if (!open) return;
    this.deps.link.followFile('files_cancel', open.launcherId);
    this.refuse(id, open.seq, 'timeout', open);
  }

  private refuse(id: string, seq: number, code: FilesErrorCode, open?: Open): void {
    this.deps.send(errorReply(id, seq, code));
    if (open) this.finish(id, code);
    else this.deps.log('files_relay_refused', { code });
  }

  private finish(id: string, outcome: string): void {
    const open = this.open.get(id);
    if (!open) return;
    clearTimeout(open.timer);
    this.deps.link.endFile(open.launcherId);
    this.open.delete(id);
    this.deps.log('files_relay_done', {
      op: open.op,
      outcome,
      chunks: open.seq,
      bytes: open.bytes,
      ms: Date.now() - open.startedAt,
    });
  }
}

/** A launcher code as the fixed code Core is told. */
export function codeFor(code: ReplyCode | undefined): FilesErrorCode {
  switch (code) {
    case 'outside_root':
    case 'denied':
    case 'not_found':
    case 'too_large':
    case 'not_regular':
    case 'busy':
      return code;
    case 'launcher_lost':
    case 'timed_out':
      return 'timeout';
    default:
      return 'failed';
  }
}
