import { z } from 'zod';
import { plainName } from './launcher-protocol';

/**
 * The file explorer's frames on the controller's socket. Down, in the stream's `{event, data}` form: `files.request`,
 * `files.more` (the next zip chunk) and `files.cancel`. Up, in the
 * `{type, ...}` form: `files.reply`, one launcher chunk or listing page each.
 *
 * Every down-frame is checked strictly here, before anything reaches the
 * launcher, which checks the path again against the real files. The bounds:
 * a box-relative path of at most 4,096 bytes and 64 parts, no
 * NUL, no `.` or `..` part, never absolute.
 */

/** The most file bytes one chunk carries: one launcher chunk, end to end. */
export const FILES_CHUNK_BYTES = 128 * 1024;
export const FILES_PATH_MAX_BYTES = 4096;
export const FILES_PATH_MAX_PARTS = 64;

/**
 * The fixed codes a reply may carry: the launcher's refusals, plus `busy`,
 * `timeout` (no answer in time, or the launcher gone), `failed` (understood
 * but not done) and `bad_request` (a request frame that failed the check).
 */
export const FILES_ERROR_CODES = [
  'outside_root',
  'denied',
  'not_found',
  'too_large',
  'not_regular',
  'busy',
  'timeout',
  'failed',
  'bad_request',
] as const;
export type FilesErrorCode = (typeof FILES_ERROR_CODES)[number];

const requestId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._:-]+$/, 'not a request id');

/** Whether `value` is a request id Core could have sent: what a refusal may be addressed to. */
export function isFilesRequestId(value: unknown): value is string {
  return requestId.safeParse(value).success;
}

/** Why a path is refused, or null when its shape is acceptable. Never echoes the path. */
export function pathShapeProblem(path: string): string | null {
  if (path.includes('\0')) return 'nul';
  if (Buffer.byteLength(path, 'utf8') > FILES_PATH_MAX_BYTES) return 'too_long';
  if (path === '') return null; // the workspaces folder itself
  if (path.startsWith('/') || path.startsWith('\\')) return 'absolute';
  const parts = path.split('/');
  if (parts.length > FILES_PATH_MAX_PARTS) return 'too_many_parts';
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return 'bad_part';
    if (part.includes('\\')) return 'bad_part';
    if (Buffer.byteLength(part, 'utf8') > 255) return 'bad_part';
  }
  return null;
}

const boxPath = z
  .string()
  .refine((path) => pathShapeProblem(path) === null, { message: 'path shape refused' });

export const filesRequestSchema = z
  .object({
    id: requestId,
    op: z.enum(['list', 'read', 'zip']),
    path: boxPath,
    // The last name of the page before, as the launcher gave it: one plain name.
    cursor: plainName.optional(),
    offset: z.number().int().nonnegative().optional(),
    length: z.number().int().positive().max(FILES_CHUNK_BYTES).optional(),
    caches: z.boolean().optional(),
  })
  .strict();
export type FilesRequest = z.infer<typeof filesRequestSchema>;

export const filesMoreSchema = z.object({ id: requestId }).strict();
export const filesCancelSchema = z.object({ id: requestId }).strict();

/** One listing entry, as the launcher gives it; the controller adds `label` at the top level only. */
export type FilesEntry = {
  name: string;
  kind: 'file' | 'folder';
  size: number;
  mtime: number;
  collapsed?: boolean;
  label?: string;
  /** The agent's stable name, on a top-level folder that is one agent's (never on "Shared"). */
  agent?: string;
};

/** The up-frame. Exactly one of a listing page, bytes, or an error. */
export type FilesReply = {
  type: 'files.reply';
  id: string;
  seq: number;
  last: boolean;
  error?: FilesErrorCode;
  entries?: FilesEntry[];
  cursor?: string;
  data?: string;
  size?: number;
};

/** An error reply: the last of its request, carrying only a fixed code. */
export function errorReply(id: string, seq: number, error: FilesErrorCode): FilesReply {
  return { type: 'files.reply', id, seq, last: true, error };
}

/** A bytes reply from one chunk; refuses a chunk bigger than `FILES_CHUNK_BYTES`. */
export function bytesReply(
  id: string,
  seq: number,
  chunk: Buffer,
  last: boolean,
  size?: number
): FilesReply {
  if (chunk.length > FILES_CHUNK_BYTES) throw new Error('chunk over the file chunk size');
  return {
    type: 'files.reply',
    id,
    seq,
    last,
    data: chunk.toString('base64'),
    ...(size === undefined ? {} : { size }),
  };
}
