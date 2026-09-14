/**
 * Mirrors `TEMPLATE_MAX_BYTES` on the server, whose default this matches.
 *
 * A guess, deliberately: the server is the authority and refuses an oversize
 * upload with a 413 either way. This only exists so a user who picks a huge
 * file is told before it is read into memory rather than after a round trip.
 * A server configured with a larger limit is not blocked by this — the check
 * only runs on the file picker, and the text area is not capped.
 */
export const MAX_DOCUMENT_BYTES = 1024 * 1024;

/** A byte count as a person would read it. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The filename a downloaded template lands as. */
export function templateFilename(name: string): string {
  const safe = name.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${safe || "template"}.yaml`;
}
