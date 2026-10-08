/**
 * An invitation to a workspace, as the link a Switch server hands out.
 *
 * The server's dashboard and its invitation e-mail both write the same shape,
 * `<origin>/invite#token=<token>`. The origin is the only thing in it that says
 * which server the workspace is on, so it is kept alongside the token rather
 * than discarded once the token is out.
 */
export type InviteLink = {
  /** The server's origin, as the link names it: scheme, host and port. */
  origin: string;
  token: string;
};

/**
 * Read a pasted invite link, or raise saying what is wrong with it.
 *
 * Deliberately narrow. Anything that is not a link to an `/invite` page with a
 * token is refused rather than guessed at, because a guess here means signing
 * in to some server and accepting nothing, and the user would be left looking
 * for a workspace the link never named.
 */
export function parseInviteLink(text: string): InviteLink {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error('Paste the invite link you were sent.');

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('That is not a link. Paste the whole invite link, starting with https://.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('That is not a link. Paste the whole invite link, starting with https://.');
  }
  if (url.pathname.replace(/\/+$/, '') !== '/invite') {
    throw new Error('That link is not an invitation. Invite links end in /invite#token=…');
  }

  const token = new URLSearchParams(url.hash.replace(/^#/, '')).get('token')?.trim();
  if (!token) {
    throw new Error('That invite link has no token in it. Copy the whole link and paste it again.');
  }
  return { origin: url.origin, token };
}
