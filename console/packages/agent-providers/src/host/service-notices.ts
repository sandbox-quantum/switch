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

/**
 * The notice for a repository the agent's grant does not reach, once a
 * repository. `fallback` is whether the session falls back to the machine's
 * own sign-in; the cloud has none, and the command fails.
 */
export function ungrantedRepositoryNotice(
  service: string,
  repository: string,
  fallback: boolean
): string {
  const name = service === 'github' ? 'GitHub' : service;
  return fallback
    ? `${repository} is not in this agent's ${name} grant, so git and gh use this machine's own ${name} sign-in for it, if it has one.`
    : `${repository} is not in this agent's ${name} grant, so git and gh have no ${name} access to it.`;
}

/** The notice for a service the session could not get through Switch; `fallback` as above. */
export function serviceFallbackNotice(service: string, reason: string, fallback: boolean): string {
  const name = service === 'github' ? 'GitHub' : service;
  const why = `${name} through Switch is unavailable in this session (${reason.replace(/\.$/, '')})`;
  return fallback
    ? `${why}, so ${service === 'github' ? 'git and gh use' : 'it uses'} this machine's own ${name} sign-in instead, if it has one.`
    : `${why}.`;
}

/**
 * Shown the first time a session asks to run a connector's tool. Connector
 * tools used to be allowed in every mode; they now follow the agent's mode.
 */
export const CONNECTOR_APPROVAL_NOTICE =
  'Connector tools ask in this mode. Turn on Bypass permissions for this agent to allow them without asking.';

/** How a notice names a catalog service; the slug for one it does not know. */
export function serviceName(service: string): string {
  const names: Record<string, string> = {
    airtable: 'Airtable',
    atlassian: 'Atlassian',
    datadog: 'Datadog',
    github: 'GitHub',
    'google-workspace': 'Google Workspace',
    trello: 'Trello',
  };
  return names[service] ?? service;
}

function listed(names: string[]): string {
  return names.length === 1
    ? names[0]!
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * What a session restarted for a change to its agent's grants is told: the
 * services that went and came. The host cannot tell a service switched off
 * for the workspace from a grant removed, so a removal names both.
 */
export function servicesChangedNotice(removed: string[], added: string[]): string | null {
  const sentences: string[] = [];
  if (removed.length > 0) {
    const one = removed.length === 1;
    sentences.push(
      `${listed(removed.map(serviceName))} ${one ? 'was' : 'were'} removed from this agent's tools: ${one ? 'it was' : 'each was'} switched off for the workspace, or its grant was removed.`
    );
  }
  if (added.length > 0)
    sentences.push(
      `${listed(added.map(serviceName))} ${added.length === 1 ? 'was' : 'were'} added to this agent's tools.`
    );
  return sentences.length > 0 ? sentences.join(' ') : null;
}
