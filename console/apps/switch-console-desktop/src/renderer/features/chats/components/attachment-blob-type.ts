/**
 * Image types the chat shows inline, by their own type. SVG is left out on
 * purpose: it can carry script.
 */
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * The type a chat attachment's bytes are kept under in the renderer (its
 * object URL's Blob). A safe image type is kept so `<img>` shows it; anything
 * else, HTML and SVG included, becomes `application/octet-stream`, so the
 * bytes can be saved but never run as a page in Console's renderer, whatever
 * opens the URL.
 */
export function attachmentBlobType(mimeType: string): string {
  const base = (mimeType.split(';')[0] ?? '').trim().toLowerCase();
  return INLINE_IMAGE_TYPES.has(base) ? base : 'application/octet-stream';
}

/** Whether the chat shows an attachment inline as an image: only a type `attachmentBlobType` keeps. */
export function showsInline(mimeType: string): boolean {
  return attachmentBlobType(mimeType) !== 'application/octet-stream';
}
