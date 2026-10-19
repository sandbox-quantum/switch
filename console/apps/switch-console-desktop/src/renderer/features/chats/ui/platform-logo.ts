import { CONSOLE_LINK_SCHEME } from '@shared/core/deeplinks/console-links';

/**
 * A messaging app named with its logo, written into a chat message as an image
 * whose alt text is the app's name and whose address is this prefix and the
 * app's `bridge_type`. Console's chat draws the logo and the name inline, where
 * an emoji would go; no emoji exists for Slack, Teams and the rest. Anywhere
 * that cannot load the image shows its alt text, the name.
 */
export const PLATFORM_LOGO_PREFIX = `${CONSOLE_LINK_SCHEME}://logo/`;

/** The markdown naming `platform` as `name`, with its logo. */
export function platformLogoMarkdown(platform: string, name: string): string {
  return `![${name}](${PLATFORM_LOGO_PREFIX}${platform})`;
}

/** The `bridge_type` an image address draws the logo of, or null when it is any other image. */
export function platformOfLogoUrl(src: unknown): string | null {
  if (typeof src !== 'string' || !src.startsWith(PLATFORM_LOGO_PREFIX)) return null;
  const platform = src.slice(PLATFORM_LOGO_PREFIX.length);
  return /^[a-z][a-z0-9_-]{0,40}$/.test(platform) ? platform : null;
}
