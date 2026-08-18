/**
 * How an agent's bot avatar is built (CHOO-2171).
 *
 * An agent's icon is stored on the Switch server as a plain URL, so this module
 * only decides which URL to offer — nothing here is persisted, and the server
 * neither knows nor cares that DiceBear produced the picture.
 *
 * Two constraints shape what is generated:
 *
 *  - **Raster, not vector.** The same URL is handed to Slack, Discord and
 *    Mattermost for a bot avatar, and none of them render SVG. An SVG link
 *    would look right in this app and show nothing on the chat platforms.
 *  - **Deterministic.** A seed always yields the same bot, so an agent's
 *    generated avatar is stable across machines and across restarts, and the
 *    "use the one from the name" reset is a value rather than a coin flip.
 */

/** DiceBear's major version. Pinned in the URL because the drawing changes
 * between majors: unpinned, every stored icon would quietly become a different
 * bot the day the service moved on. */
const DICEBEAR_VERSION = '9.x';

/** Rendered size in pixels. The largest place an avatar appears is the agent
 * page at 88px, so 256 keeps it sharp on a 2x display without making the
 * sidebar's 21px copies expensive. */
const AVATAR_PIXELS = 256;

/** How many bots the picker shows at once. */
export const AVATAR_CHOICE_COUNT = 10;

/**
 * The avatar URL for an arbitrary seed. Any string works; the same string
 * always draws the same bot.
 */
export function agentAvatarUrlForSeed(seed: string): string {
  const params = new URLSearchParams({ seed, size: String(AVATAR_PIXELS) });
  return `https://api.dicebear.com/${DICEBEAR_VERSION}/bottts/png?${params.toString()}`;
}

/**
 * The avatar an agent gets from its own name — the one the picker offers first
 * and the one the ✕ reset returns to.
 */
export function agentAvatarUrlForName(agentName: string): string {
  return agentAvatarUrlForSeed(agentName);
}

/**
 * One page of choices for the picker. `round` 0 leads with the agent's own
 * name, so the first tile is the avatar it already has; later rounds are
 * different bots.
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

/**
 * The letters shown when an agent has no picture to draw — either because the
 * image failed to load or because nothing has been chosen and no name-derived
 * avatar is wanted.
 *
 * Underscores and hyphens count as word breaks so `switch_worker` reads as
 * `SW`, matching what the Switch bridges put on Slack for the same agent.
 */
export function agentInitials(agentName: string): string {
  const words = agentName.split(/[\s_-]+/).filter((word) => word.length > 0);
  if (words.length === 0) return '?';
  const letters = words.slice(0, 2).map((word) => word[0]);
  return letters.join('').toUpperCase();
}
