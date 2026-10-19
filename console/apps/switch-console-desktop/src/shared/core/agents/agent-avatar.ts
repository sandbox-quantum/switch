/**
 * How an agent's avatar is built (CHOO-2171).
 *
 * An agent's icon is stored on the Switch server as a plain URL, so this module
 * only decides which URL to offer — nothing here is persisted.
 *
 * Two constraints shape what is generated:
 *
 *  - **Raster, not vector.** The same URL is handed to Slack, Discord and
 *    Mattermost for a bot avatar, and none of them render SVG. An SVG link
 *    would look right in this app and show nothing on the chat platforms.
 *  - **Deterministic.** A seed always yields the same face, so an agent's
 *    generated avatar is stable across machines and across restarts, and the
 *    "use the one from the name" reset is a value rather than a coin flip.
 */

/** DiceBear's major version. Pinned in the URL because the drawing changes
 * between majors: unpinned, every stored icon would quietly become a different
 * face the day the service moved on. */
const DICEBEAR_VERSION = '10.x';

/** DiceBear's "gaze" style. The Switch server generates the same URL
 * (`core/switch_core/agent_icon.py`); the two must stay identical, or an agent
 * wears a different face here than on the chat platforms. */
const DICEBEAR_STYLE = 'gaze';

/** Rendered size in pixels. The largest place an avatar appears is the agent
 * page at 88px, so 256 keeps it sharp on a 2x display without making the
 * sidebar's 21px copies expensive. */
const AVATAR_PIXELS = 256;

/** Drawn a tenth larger than DiceBear's default, which leaves the body small
 * at chat-avatar size. Every shape is allowed: listing all but the arch (the
 * one a round crop trims at this scale) made the URL too long for Slack. */
const AVATAR_SCALE = '1.1';

/** How many avatars the picker shows at once. */
export const AVATAR_CHOICE_COUNT = 10;

/**
 * The avatar URL for an arbitrary seed. Any string works; the same string
 * always draws the same face.
 */
export function agentAvatarUrlForSeed(seed: string): string {
  const params = new URLSearchParams({ seed, size: String(AVATAR_PIXELS), scale: AVATAR_SCALE });
  return `https://api.dicebear.com/${DICEBEAR_VERSION}/${DICEBEAR_STYLE}/png?${params.toString()}`;
}

/**
 * The avatar an agent gets from its own name — the one the picker offers first
 * and the one the ✕ reset returns to.
 */
export function agentAvatarUrlForName(agentName: string): string {
  return agentAvatarUrlForSeed(agentName);
}

/**
 * An avatar drawn from a fresh random seed.
 *
 * For a *new* agent, whose name is not typed yet and whose eventual name is no
 * reason for two people's agents to look alike. Determinism is the point
 * everywhere else in this module, so the randomness is confined to picking the
 * seed: once drawn, the URL is an ordinary stable one.
 */
export function randomAgentAvatarUrl(): string {
  return agentAvatarUrlForSeed(crypto.randomUUID());
}

/**
 * One page of choices for the picker. `round` 0 leads with the agent's own
 * name, so the first tile is the avatar it already has; later rounds are
 * different faces.
 *
 * Rounds are derived from the name rather than drawn at random so that the
 * same agent offers the same choices every time the picker is opened — a grid
 * that reshuffles itself on every render is impossible to choose from, and
 * impossible to test.
 */
export function agentAvatarChoices(agentName: string, round: number): string[] {
  const seeds =
    round === 0
      ? [agentName, ...sequentialSeeds(agentName, 0, AVATAR_CHOICE_COUNT - 1)]
      : sequentialSeeds(agentName, round, AVATAR_CHOICE_COUNT);
  return seeds.map(agentAvatarUrlForSeed);
}

function sequentialSeeds(agentName: string, round: number, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${agentName}-${round}-${index}`);
}

/** The services `isThirdPartyAvatarUrl` matches, any host under them included. */
const THIRD_PARTY_AVATAR_SERVICES = ['dicebear.com', 'ui-avatars.com'];

/**
 * Whether `url` is drawn by an outside avatar service: DiceBear, which draws
 * the generated faces, or ui-avatars.com, which Switch uses for a person
 * relayed from another platform. Those services see whatever is in the URL and
 * the address of whoever loads it.
 *
 * The server draws the same line (`is_third_party_avatar` in
 * `core/switch_core/agent_icon.py`) for `THIRD_PARTY_AVATARS_ENABLED`, so the
 * two must agree, or this app would load an icon the server withholds from
 * Slack. An unparseable URL names neither service.
 */
export function isThirdPartyAvatarUrl(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  // A trailing dot names the same host.
  const host = hostname.replace(/\.+$/, '');
  return THIRD_PARTY_AVATAR_SERVICES.some(
    (service) => host === service || host.endsWith(`.${service}`)
  );
}

/**
 * The URL `AgentAvatar` should load, or null to show initials.
 *
 * `thirdPartyAvatarsEnabled` is the agent's server's setting, or null while it
 * is not known. Unknown behaves as disabled, so no name leaves the machine
 * before the server has said it may.
 */
export function resolveAgentAvatarSrc(
  iconUrl: string | null,
  name: string,
  thirdPartyAvatarsEnabled: boolean | null
): string | null {
  if (thirdPartyAvatarsEnabled === true) {
    return iconUrl ?? agentAvatarUrlForName(name);
  }
  // An icon on any other host still shows.
  return iconUrl !== null && !isThirdPartyAvatarUrl(iconUrl) ? iconUrl : null;
}

/**
 * The letters shown when an agent has no picture to draw — either because the
 * image failed to load or because nothing has been chosen and no name-derived
 * avatar is wanted.
 *
 * Underscores and hyphens count as word breaks so `switch_worker` reads as
 * `SW`.
 */
export function agentInitials(agentName: string): string {
  const words = agentName.split(/[\s_-]+/).filter((word) => word.length > 0);
  if (words.length === 0) return '?';
  const letters = words.slice(0, 2).map((word) => word[0]);
  return letters.join('').toUpperCase();
}
