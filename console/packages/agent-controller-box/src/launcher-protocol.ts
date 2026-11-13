import { z } from 'zod';

/**
 * The socket between the controller (uid 2001, the only one holding secrets)
 * and the launcher (uid 2000, pid 1 of the agents container), for boxes where
 * the controller runs as its own user.
 *
 * The launcher runs as the same user as the agents' tools, so everything it
 * sends is untrusted: each line is one JSON message of a fixed kind, checked
 * against a strict shape with a size cap, carrying ids and numbers only. The
 * controller acts on agent ids and numbers from it, never a path, a pid or a
 * file name. The controller's orders carry nothing a tool could
 * use beyond its own agent: never the controller's credential, the gateway
 * token or the marker key.
 *
 * The file explorer's orders (`files_*`) are the one place names cross from
 * the launcher: a listing's entry names and a file's bytes, for the owner's
 * Console. The controller passes them on to Core and never acts on them, opens
 * them or logs them; each name is checked here as one plain name.
 */

/** The longest line either side reads; a launch, with its template, is the largest. */
export const LAUNCHER_LINE_MAX = 256 * 1024;

const agentId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const requestId = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const launchId = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** A host ticket: 128 random bits, as hex. */
const ticket = z.string().regex(/^[0-9a-f]{32}$/);
/** One launch's owner marker: an HMAC, as hex (the key never crosses). */
const marker = z.string().regex(/^[0-9a-f]{64}$/);
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative().max(1_000_000);

// -- The file explorer (`files_*`) -------------------------------------------

/** The most entries one `files_list` page gives. */
export const FILES_PAGE_MAX = 1000;
/**
 * The most bytes one `files_chunk` carries, before base64: base64 makes it
 * 4/3 bigger, and the line must stay under `LAUNCHER_LINE_MAX`.
 */
export const FILES_CHUNK_MAX = 128 * 1024;
const FILES_CHUNK_BASE64_MAX = Math.ceil(FILES_CHUNK_MAX / 3) * 4;
/**
 * One plain name: not empty, not `.` or `..`, no `/`, NUL or backslash, and at
 * most 255 bytes, as a Linux file name is.
 */
export const plainName = z
  .string()
  .min(1)
  .max(255)
  .refine((name) => name !== '.' && name !== '..' && !/[/\\\u0000]/.test(name), 'not a plain name')
  .refine((name) => Buffer.byteLength(name, 'utf8') <= 255, 'name too long');
/**
 * A path under the workspaces folder, relative and made of plain names joined
 * by `/`, at most 4,096 bytes and 64 parts; the empty string is the folder itself. The launcher checks it again,
 * with `realpath`, before it opens anything.
 */
export const FILES_PATH_BYTES_MAX = 4096;
export const FILES_PATH_PARTS_MAX = 64;
export const filesPath = z
  .string()
  .max(FILES_PATH_BYTES_MAX)
  .refine((path) => Buffer.byteLength(path, 'utf8') <= FILES_PATH_BYTES_MAX, 'path too long')
  .refine((path) => path === '' || path.split('/').length <= FILES_PATH_PARTS_MAX, 'too many parts')
  .refine(
    (path) => path === '' || path.split('/').every((part) => plainName.safeParse(part).success),
    'not a relative path of plain names'
  );

// -- The controller's orders -------------------------------------------------

export const launcherOrderSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('launch'),
      id: requestId,
      agentId,
      launchId,
      /** The shared-host configuration, as the controller builds it; checked again by the launcher's own schema. */
      template: z.record(z.string(), z.unknown()),
      marker,
      ticket,
      /** The agent's relay credentials: per agent, issued by the controller. */
      credentials: z
        .object({
          endpoint: z.string().max(512),
          token: z.string().max(512),
          hub: z.string().max(512),
        })
        .strict(),
      /** The working directory to make before starting, when it is inside the workspaces folder. */
      directory: z.string().min(1).max(4096).optional(),
      restart: z.boolean(),
      replaceIdentity: z.boolean(),
      clearTakenOver: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('stop'),
      id: requestId,
      agentId,
      wait: z.boolean(),
      asked: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal('observe'), id: requestId, agentId }).strict(),
  /** The memory guard's steps: the launcher signals only processes it proves the agent's. */
  z.object({ kind: z.enum(['freeze', 'thaw', 'end']), id: requestId, agentId }).strict(),
  /** A resting agent's leftovers, ended with proof. */
  z.object({ kind: z.literal('sweep'), id: requestId, agentId }).strict(),
  /** Start the session a message to `roomId` would start, through the host's control port. */
  z
    .object({ kind: z.literal('warm'), id: requestId, agentId, roomId: z.string().min(1).max(255) })
    .strict(),
  /** The memory guard is stopping the agent: its host tells its rooms, through its control port. */
  z.object({ kind: z.literal('memory_notice'), id: requestId, agentId }).strict(),
  /**
   * A provider sign-in check, run in the agents container: the CLI with the
   * gateway's probe environment (a short-lived probe token, never a login).
   */
  z
    .object({
      kind: z.literal('probe'),
      id: requestId,
      provider: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
      binaryPath: z.string().min(1).max(4096),
      env: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/), z.string().max(4096)),
    })
    .strict(),
  /**
   * The controller's settings, sent after every hello. `operatorExec`: on a
   * box its template marks as a test box only, an operator's exec (a parent-
   * pid-0 tree) is left running, counted to the box, instead of ended.
   */
  z.object({ kind: z.literal('settings'), id: requestId, operatorExec: z.boolean() }).strict(),
  /**
   * The agents' disk: free and total bytes of the launcher's data folder (the
   * agents' volume), which the controller's container doesn't mount, so only
   * the launcher can measure it. Numbers only come back.
   */
  z.object({ kind: z.literal('disk'), id: requestId }).strict(),
  /** A fresh ticket for a living host to reconnect with, pushed over its control channel. */
  z.object({ kind: z.literal('ticket'), id: requestId, agentId, launchId, ticket }).strict(),
  /** One page of a folder under the workspaces folder, after `cursor` (the last name of the page before). */
  z
    .object({
      kind: z.literal('files_list'),
      id: requestId,
      path: filesPath,
      cursor: plainName.optional(),
    })
    .strict(),
  /** Bytes of one file under the workspaces folder, answered as one `files_chunk`. */
  z
    .object({
      kind: z.literal('files_read'),
      id: requestId,
      path: filesPath,
      offset: bytes,
      length: z.number().int().min(1).max(FILES_CHUNK_MAX),
    })
    .strict(),
  /** A folder as a zip, one `files_chunk` at a time: the first comes unasked, each next after `files_more`. */
  z
    .object({
      kind: z.literal('files_zip'),
      id: requestId,
      path: filesPath,
      includeCaches: z.boolean(),
    })
    .strict(),
  /** The next chunk of the zip `id`. */
  z.object({ kind: z.literal('files_more'), id: requestId }).strict(),
  /** Stop the file request `id` and close what it holds. An unknown id is ignored. */
  z.object({ kind: z.literal('files_cancel'), id: requestId }).strict(),
]);
export type LauncherOrder = z.infer<typeof launcherOrderSchema>;

// -- What the launcher reports -----------------------------------------------

/**
 * Why a host isn't running, as `observe` says it: a fixed code, never the
 * host's own words, which come from the agents' side. The
 * controller turns each into a fixed line of its own for status; an unknown
 * one counts as `other`.
 */
export const HOST_FAILURES = [
  'credentials_rejected',
  'provider_missing',
  'host_failed',
  'other',
] as const;
export type HostFailure = (typeof HOST_FAILURES)[number];

/** The launcher's reading of a host's failure message, as a code. */
export function hostFailureCode(message: string): HostFailure {
  if (/rejected the agent credentials|credentials belong to a different agent/i.test(message))
    return 'credentials_rejected';
  if (/executable is missing|not found on this machine|ENOENT/i.test(message))
    return 'provider_missing';
  return 'host_failed';
}

/** What `hello` may carry as its version and bundle name, so either is safe to log. */
const SAFE_LABEL = /^[A-Za-z0-9._+-]{1,64}$/;

/**
 * Every reason a reply can give for not doing an order. The first four come
 * from the launcher; the controller's link makes the last two itself.
 */
export const REPLY_CODES = [
  'bad_template', // a launch's template failed the launcher's own schema
  'bad_directory', // a launch's working directory is outside the agents' folders
  'unknown_agent', // an order for an agent the launcher hasn't launched
  'failed', // the order was understood but could not be done
  // The file explorer's refusals (`files_*`):
  'outside_root', // the path isn't under the workspaces folder, or a link leads out of it
  'denied', // the path names something never readable (a login, a key, a cache of tokens)
  'not_found', // nothing there, or the zip `id` is unknown
  'too_large', // over the file, folder or zip cap
  'not_regular', // not a regular file or folder (a device, pipe or socket)
  'busy', // too many file requests already in flight
  'launcher_lost', // the controller's link: no launcher connected
  'timed_out', // the controller's link: no answer in time
] as const;
export type ReplyCode = (typeof REPLY_CODES)[number];

export const launcherReportSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('hello'),
      /** Safe to log: letters, digits and `._+-` only. */
      version: z.string().regex(SAFE_LABEL),
      /** The shared-host bundle's file name (never a path), safe to log. */
      bundle: z.string().regex(SAFE_LABEL),
      /** Fresh each time the agents container starts: a new one means every host is gone. */
      bootId: z.string().regex(/^[0-9a-f]{32}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal('reply'),
      id: requestId,
      ok: z.boolean(),
      /** A fixed reason code when not ok; never free text. A new code is a reviewed change here. */
      code: z.enum(REPLY_CODES).optional(),
      /** `observe`'s answer; the controller checks it against its own observation schema. */
      observation: z.record(z.string(), z.unknown()).optional(),
      /** `end`/`sweep`: how many processes were signalled, gone, or not proven. */
      counts: z
        .object({ signalled: count, gone: count, notProven: count, disputed: count, left: count })
        .strict()
        .optional(),
      /** `memory_notice`: how many rooms the host told. */
      told: count.optional(),
      /** `probe`: the provider's answer, checked again by the controller's own schema. */
      readiness: z.record(z.string(), z.unknown()).optional(),
      /** `disk`: the agents' volume, in bytes. */
      disk: z.object({ free: bytes, total: bytes }).strict().optional(),
      /** `files_list`: one page, and the cursor for the next when there is more. */
      listing: z
        .object({
          entries: z
            .array(
              z
                .object({
                  name: plainName,
                  kind: z.enum(['file', 'folder']),
                  size: bytes,
                  /** Last changed, ms since the epoch. */
                  mtime: bytes,
                  /** A cache folder (`node_modules`, `.git`, ...), shown closed. */
                  collapsed: z.literal(true).optional(),
                })
                .strict()
            )
            .max(FILES_PAGE_MAX),
          cursor: plainName.optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  /**
   * File bytes for `files_read` (one chunk, `last`) or `files_zip` (in order
   * from `seq` 0, the last marked `last`). `size`: the whole file's size, on a
   * read.
   */
  z
    .object({
      kind: z.literal('files_chunk'),
      id: requestId,
      seq: count,
      data: z
        .string()
        .max(FILES_CHUNK_BASE64_MAX)
        .regex(/^[A-Za-z0-9+/]*={0,2}$/),
      last: z.boolean(),
      size: bytes.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('measure'),
      /** The launcher's clock, ms; the controller times silence by its own. */
      at: bytes,
      agents: z.record(
        agentId,
        z
          .object({
            bytes,
            processes: count,
            /** Bytes in processes carrying the agent's marker but not first seen under its tree (C8). */
            disputedBytes: bytes,
          })
          .strict()
      ),
      /**
       * Processes that are no agent's (no first sight, no current marker):
       * counted to the box, and ended once seen in two scans in a row.
       */
      strangers: z.object({ processes: count, bytes, ended: count }).strict().optional(),
      /** Test boxes with operator exec on: the operator's exec trees, counted to the box. */
      operator: z.object({ processes: count, bytes }).strict().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('exited'),
      agentId,
      launchId,
      /**
       * Why it is gone: `gone` by itself; `unconfirmed`, ended because it never
       * confirmed its push key in 5 s; `wrong_port`, ended because its control
       * port wasn't its own. The last two count as an unknown ticket.
       */
      reason: z.enum(['gone', 'unconfirmed', 'wrong_port']).optional(),
    })
    .strict(),
]);
export type LauncherReport = z.infer<typeof launcherReportSchema>;

/** Why a line was refused: fixed codes, for a log line that carries no text from the line. */
export type LineRefusal = 'too_long' | 'not_json' | 'bad_shape';

/**
 * Splits a byte stream into newline-delimited messages and checks each against
 * `schema`. A line past `LAUNCHER_LINE_MAX` is dropped up to its newline, never
 * held whole; a refused line costs only itself. What is refused is reported as
 * a code, so a log line never repeats anything the other side wrote.
 */
export class LineReader<T> {
  private parts: Buffer[] = [];
  private held = 0;
  private skipping = false;

  constructor(
    private readonly schema: z.ZodType<T>,
    private readonly onMessage: (message: T) => void,
    private readonly onRefused: (reason: LineRefusal) => void,
    private readonly maxLine = LAUNCHER_LINE_MAX
  ) {}

  feed(chunk: Buffer): void {
    let start = 0;
    for (let at = chunk.indexOf(0x0a, start); at >= 0; at = chunk.indexOf(0x0a, start)) {
      this.take(chunk.subarray(start, at));
      this.finish();
      start = at + 1;
    }
    if (start < chunk.length) this.take(chunk.subarray(start));
  }

  private take(piece: Buffer): void {
    if (this.skipping) return;
    if (this.held + piece.length > this.maxLine) {
      this.parts = [];
      this.held = 0;
      this.skipping = true;
      this.onRefused('too_long');
      return;
    }
    this.parts.push(piece);
    this.held += piece.length;
  }

  private finish(): void {
    if (this.skipping) {
      this.skipping = false;
      return;
    }
    const line = Buffer.concat(this.parts, this.held).toString('utf8');
    this.parts = [];
    this.held = 0;
    if (line.trim() === '') return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.onRefused('not_json');
      return;
    }
    const parsed = this.schema.safeParse(value);
    if (parsed.success) this.onMessage(parsed.data);
    else this.onRefused('bad_shape');
  }
}

/** One message as a line to write. */
export function encodeLine(message: LauncherOrder | LauncherReport): string {
  return `${JSON.stringify(message)}\n`;
}
