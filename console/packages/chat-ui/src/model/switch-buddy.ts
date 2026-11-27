/**
 * The picture the switch-buddy template gives the buddy: the same image as
 * `assets/switch-buddy.png` at the repository root, which the messaging apps
 * load from here. Switch Console shows its own bundled copy wherever an agent
 * carries this URL, so the buddy has its face before (and without) that URL
 * being reachable.
 */
export const BUDDY_ICON_URL =
  'https://raw.githubusercontent.com/sandbox-quantum/switch/main/assets/switch-buddy.png';

/** A URL's path as the server answering it reads it: decoded, in one case, single slashes. */
function servedPath(pathname: string): string {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape is left as written; it cannot then equal the buddy's path.
  }
  return decoded.toLowerCase().replace(/\/{2,}/g, '/');
}

const BUDDY_ICON = new URL(BUDDY_ICON_URL);

/**
 * Whether an icon URL points at switch-buddy's picture where the template
 * keeps it: the same host and path over http or https, whatever query or
 * fragment is added (`?v=1` loads the same image). Only that address is
 * recognised. Console never looks at the image itself, so the same picture
 * copied anywhere else (a fork, another ref, another host) is not: what tells
 * such an agent apart is its unique name, shown beside its display name.
 */
export function isBuddyIconUrl(iconUrl: string | null): boolean {
  if (iconUrl === null) return false;
  let url: URL;
  try {
    url = new URL(iconUrl.trim());
  } catch {
    return false;
  }
  return (
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.hostname === BUDDY_ICON.hostname &&
    servedPath(url.pathname) === servedPath(BUDDY_ICON.pathname)
  );
}

/** `from`'s letters paired with `to`'s, which must be as many. Each letter is one code point. */
function pairs(from: string, to: string): [string, string][] {
  const letters = Array.from(from);
  const latin = Array.from(to);
  if (letters.length !== latin.length) throw new Error(`lookalikes ${from} and ${to} do not pair`);
  return letters.map((letter, at) => [letter, latin[at]!]);
}

/**
 * Letters that NFKD leaves alone but that read as a Latin one in the app's
 * font: Cyrillic and Greek lookalikes, Latin small capitals and dotless i, and
 * `l`, `1` and `|` for `i`. Each is mapped in its own case, since a Greek
 * capital Upsilon reads as Y while its small letter reads as u.
 */
const LOOKALIKES = new Map([
  // Cyrillic
  ...pairs('АВЕЅІЈКМНОРСТХУҮҺԀԜӀЬ', 'ABESIJKMHOPCTXYYHDWIb'),
  ...pairs('авеѕіјкмнорстхуүһԁԝӏьпг', 'abesijkmhopctxyyhdwibnr'),
  // Greek
  ...pairs('ΑΒΕΖΗΙΚΜΝΟΡΤΥΧϹͿ', 'ABEZHIKMNOPTYXCJ'),
  ...pairs('αβγικμνορτυχωϲϳ', 'abyikuvoptuxwcj'),
  // Latin letters without a compatibility decomposition
  ...pairs('ıɩɪʙᴄᴅʜᴛᴜᴡʏꜱ', 'iiibcdhtuwys'),
  // What passes for an i
  ...pairs('l1|', 'iii'),
]);
const LOOKALIKE = new RegExp(`[${[...LOOKALIKES.keys()].join('')}]`, 'gu');

/**
 * Whether a name an agent's owner chose reads as switch-buddy's: "Switch
 * Buddy", "switch_buddy", "Your switch-buddy" and the like, compared without
 * case, accents, spaces or punctuation, and with letters of other scripts
 * that look Latin ("Swіtch" with a Cyrillic і) read as the Latin ones, as is
 * `vv` for `w`.
 */
export function readsAsSwitchBuddy(text: string): boolean {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(LOOKALIKE, (letter) => LOOKALIKES.get(letter)!)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/vv/g, 'w')
    .includes('switchbuddy');
}
