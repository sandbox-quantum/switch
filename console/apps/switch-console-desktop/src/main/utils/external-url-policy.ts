function protocolOf(url: string): string | null {
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}

/** An ordinary web address, the only kind that may leave the app for the browser. */
export function isHttpUrl(url: string): boolean {
  const protocol = protocolOf(url);
  return protocol === 'http:' || protocol === 'https:';
}

/**
 * Whether a frame may navigate to `url`: web pages, plus the documents a web
 * page makes for itself (`about:blank`, `blob:`, `data:`). Anything else is a
 * scheme the OS would hand to whichever app registered it.
 */
export function isWebContentUrl(url: string): boolean {
  const protocol = protocolOf(url);
  return (
    protocol === 'http:' ||
    protocol === 'https:' ||
    protocol === 'about:' ||
    protocol === 'blob:' ||
    protocol === 'data:'
  );
}

/**
 * The schemes Console hands to the OS: the web, plus the messaging apps a
 * room's channel opens in (links built from a room's bridge). Other schemes
 * (file:, javascript:, …) stay blocked. Telegram needs no entry: its links are
 * ordinary https `t.me` URLs.
 */
const EXTERNAL_PROTOCOLS: ReadonlySet<string> = new Set([
  'http:',
  'https:',
  'slack:',
  'mattermost:',
  'discord:',
]);

/** Whether Console may ask the OS to open `url` at all. */
export function isAllowedExternalUrl(url: string): boolean {
  const protocol = protocolOf(url);
  return protocol !== null && EXTERNAL_PROTOCOLS.has(protocol);
}
