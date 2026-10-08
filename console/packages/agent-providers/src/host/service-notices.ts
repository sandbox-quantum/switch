/**
 * What a session says about its services falling back: GitHub through Switch
 * unavailable, so git and gh use the machine's own sign-in. Each distinct
 * notice is logged and shown in the session once. One raised before the
 * session is up (as it starts, or from the service endpoint, which starts
 * first) waits until it is.
 */
export class ServiceNotices {
  private readonly said = new Set<string>();
  private readonly waiting: string[] = [];
  private show: ((message: string) => Promise<void>) | null = null;

  raise(message: string): void {
    if (this.said.has(message)) return;
    this.said.add(message);
    console.warn(message);
    if (this.show) this.publish(this.show, message);
    else this.waiting.push(message);
  }

  /** Show notices in the session from now on, and those raised before. */
  attach(show: (message: string) => Promise<void>): void {
    this.show = show;
    for (const message of this.waiting.splice(0)) this.publish(show, message);
  }

  private publish(show: (message: string) => Promise<void>, message: string): void {
    show(message).catch((error: unknown) =>
      console.warn(
        `Could not show a service notice in the session: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }
}

/** The notice for a service the session could not get through Switch. */
export function serviceFallbackNotice(service: string, reason: string): string {
  const name = service === 'github' ? 'GitHub' : service;
  return `${name} through Switch is unavailable in this session (${reason.replace(/\.$/, '')}), so ${
    service === 'github' ? 'git and gh use' : 'it uses'
  } this machine's own ${name} sign-in instead, if it has one.`;
}
