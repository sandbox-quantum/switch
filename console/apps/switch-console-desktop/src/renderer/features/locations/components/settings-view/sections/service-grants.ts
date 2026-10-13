import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import type { GitHubConnection } from '@shared/core/switch-servers/github-connection';

/** The repository ids a GitHub grant names. */
export function grantedRepositoryIds(resources: Record<string, unknown>): number[] {
  const ids = resources.repository_ids;
  return Array.isArray(ids) ? ids.filter((id): id is number => typeof id === 'number') : [];
}

/**
 * The repositories a GitHub grant names, by their full name (`owner/name`, as
 * GitHub gives it) where the person can still see them and by id where they
 * no longer can.
 */
export function grantedRepositoryNames(
  github: GitHubConnection | undefined,
  resources: Record<string, unknown>
): string[] {
  const installation =
    github?.status === 'connected'
      ? github.installations.find((candidate) => candidate.id === resources.installation_id)
      : undefined;
  return grantedRepositoryIds(resources).map((id) => {
    const repository = installation?.repositories.find((candidate) => candidate.id === id);
    return repository ? repository.name : `repository ${id}`;
  });
}

const APP_NOTE = 'Pushes, pull requests and comments show as the Switch GitHub App, not you.';

/** What a GitHub grant means for a cloud agent, which has no other GitHub sign-in. */
export const CLOUD_GITHUB_GRANT_NOTES = [APP_NOTE] as const;

/**
 * What removing a grant does for an agent on the owner's own machine, and
 * what it does not. A cloud agent has no other sign-in, so there removing it
 * simply ends the access.
 */
export const REMOVED_GRANT_NOTE =
  'Removing a grant stops Switch giving this access. On your computer, the agent may still use your own sign-in, and the session says so when it does.';

/**
 * What turning on a service whose agents use the owner's own token means, and
 * how long turning it off takes: Switch stops handing it out within a minute,
 * and a token that lives longer stays valid at the vendor until it expires. A
 * service connected with a key hands out the key itself, which does not
 * expire, so its note says only how far the key reaches.
 */
export function onOffGrantNote(
  agentName: string,
  service: Pick<ConnectionCatalogEntry, 'name' | 'token_lifetime' | 'key'>
): string {
  const { name } = service;
  const off = `Turning it off stops its sessions using ${name} within a minute.`;
  if (service.key !== null)
    return `On, ${agentName} uses ${name} with your key, as far as the key allows. ${off}`;
  const note = `On, ${agentName} acts as you at ${name}, with everything your ${name} connection allows. ${off}`;
  return service.token_lifetime !== null && service.token_lifetime > 3600
    ? `${note} A token already handed out stays valid at ${name} until it expires or you disconnect.`
    : note;
}

/** What a GitHub grant changes on the machine the agent runs on, and what it does not. */
export const GITHUB_GRANT_NOTES = [
  APP_NOTE,
  "Used first for this agent over HTTPS. For repositories outside the grant, or if Switch can't provide it, your own GitHub login is used and the session says so. SSH still uses your keys.",
  "On your computer, the agent can still use anything you're signed in to.",
  'Not available on Windows yet.',
] as const;
