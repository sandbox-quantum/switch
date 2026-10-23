/**
 * Launches that arrive while Console is quitting, kept so Console can start
 * again with them once it has quit.
 *
 * The deep link is kept apart from the rest of the arguments: a plain launch
 * after a deep link must not lose the link, and a later deep link replaces an
 * earlier one, since that is the one the person clicked last.
 */
export class LaunchesWhileQuitting {
  private args: string[] | null = null;
  private link: string | null = null;

  constructor(private readonly findDeeplink: (argv: string[]) => string | undefined) {}

  /** Record a launch, given its arguments without the executable. */
  note(args: string[]): void {
    const link = this.findDeeplink(args);
    if (link) this.link = link;
    this.args = args.filter((arg) => arg !== link);
  }

  /** The deep link to open after the restart, if any launch carried one. */
  get deeplink(): string | null {
    return this.link;
  }

  /** Arguments to start Console again with, or null when no launch arrived. */
  relaunchArgs(): string[] | null {
    if (this.args === null) return null;
    return this.link ? [...this.args, this.link] : [...this.args];
  }
}
