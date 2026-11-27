/**
 * Characters that reorder or hide the text around them: the bidi embeddings,
 * overrides and isolates, the left-to-right and right-to-left marks, the
 * zero-width space, the word joiner and the byte-order mark. With them a file
 * named `invoice<U+202E>fdp.exe` reads as "invoiceexe.pdf". The zero-width
 * non-joiner and joiner are not among them: scripts and emoji need them.
 */
const REORDERING = /[\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

/** Control characters, path separators and the characters Windows refuses in a file name. */
const UNSAFE = /[\u0000-\u001F\u007F-\u009F/\\:*?"<>|]/g;

/**
 * An attachment's name as Console shows it and suggests saving it under: each
 * reordering, hidden, control or path character replaced with `_`, and leading
 * and trailing dots and spaces dropped, so the name reads in the order its
 * characters are stored, the extension shown is the real one, and the saved
 * file is neither hidden nor somewhere else. Anyone in a room can name a file.
 */
export function attachmentFilename(name: string): string {
  const safe = name
    .replace(REORDERING, '_')
    .replace(UNSAFE, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  return safe || 'attachment';
}
