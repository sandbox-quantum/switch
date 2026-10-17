/**
 * The run id, and every name built from it.
 *
 * On a deployed environment many runs share one tenant over time, so whatever a
 * run creates has to be recognisable as that run's: list assertions filter on
 * it, teardown deletes by it, and the scheduled wipe finds leftovers by the
 * shared prefix. That only holds if no scenario ever builds a raw name itself,
 * so every name goes through {@link NameScope.name}.
 *
 * Names are `e2e-<runId><scope>-<role>`: the run, then a letter per scenario so
 * two scenarios can both ask for a `sender` without colliding, then what the
 * thing is for.
 */

/** Everything the harness creates starts with this. The cleanup script deletes by it. */
export const ARTIFACT_PREFIX = 'e2e-';

/**
 * Mattermost usernames: lowercase, 3-22 chars, `[a-z0-9._-]`, must start
 * alphanumeric. Agent names become Mattermost bot usernames verbatim, so every
 * agent name has to pass this, bridged or not.
 */
export function isValidMattermostUsername(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{2,21}$/.test(name);
}

/** Lowercase, filesystem- and Mattermost-username-safe run id. */
export function shortId(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0');
}

const SCOPE_LETTERS = 'abcdefghijklmnopqrstuvwxyz';

export class RunContext {
  readonly runId: string;
  private scopes = 0;

  constructor(runId: string = shortId()) {
    if (!/^[a-z0-9]{6}$/.test(runId)) {
      throw new Error(`Run id '${runId}' must be six lowercase alphanumerics.`);
    }
    this.runId = runId;
  }

  /** A fresh set of names for one scenario (or one setup), distinct from every other scope's. */
  scope(): NameScope {
    const letter = SCOPE_LETTERS[this.scopes];
    if (letter === undefined) {
      throw new Error(`Run ${this.runId} ran out of name scopes (${SCOPE_LETTERS.length}).`);
    }
    this.scopes += 1;
    return new NameScope(this.runId, letter);
  }

  /** Whether a name belongs to this run. */
  owns(name: string): boolean {
    return name.startsWith(`${ARTIFACT_PREFIX}${this.runId}`);
  }
}

export class NameScope {
  readonly runId: string;
  private readonly letter: string;
  private readonly used = new Set<string>();

  constructor(runId: string, letter: string) {
    this.runId = runId;
    this.letter = letter;
  }

  /**
   * The name for an agent, room or channel.
   *
   * `role` is kept short because the result has to fit a Mattermost username;
   * a name that does not is refused here rather than failing bot creation on
   * the bridge, where it surfaces only as a room that is never provisioned.
   * Asking for the same role twice is refused too: two artefacts sharing a name
   * would make teardown and every by-name lookup ambiguous.
   */
  name(role: string): string {
    const name = `${ARTIFACT_PREFIX}${this.runId}${this.letter}-${role}`;
    if (!isValidMattermostUsername(name)) {
      throw new Error(
        `Derived name '${name}' is not a valid Mattermost username ` +
          `(lowercase, 3-22 chars, [a-z0-9._-]). Shorten the role '${role}'.`
      );
    }
    if (this.used.has(name)) throw new Error(`Name '${name}' was already handed out.`);
    this.used.add(name);
    return name;
  }

  /** A marker string unique to this scope, for grepping a transcript. */
  marker(label: string): string {
    return `SWITCH_E2E_${label.toUpperCase()}_${this.runId.toUpperCase()}${this.letter.toUpperCase()}`;
  }
}
