import type { GitHubConnection } from '@shared/core/switch-servers/github-connection';

/** The repository ids a GitHub grant names. */
export function grantedRepositoryIds(resources: Record<string, unknown>): number[] {
  const ids = resources.repository_ids;
  return Array.isArray(ids) ? ids.filter((id): id is number => typeof id === 'number') : [];
}

/**
 * The repositories a GitHub grant names, as `account/name` where the person
 * can still see them and by id where they no longer can.
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
    return repository && installation
      ? `${installation.account}/${repository.name}`
      : `repository ${id}`;
  });
}

const APP_NOTE = 'Pushes, pull requests and comments show as the Switch GitHub App, not you.';

/** What a GitHub grant means for a cloud agent, which has no other GitHub sign-in. */
export const CLOUD_GITHUB_GRANT_NOTES = [APP_NOTE] as const;

/** What a GitHub grant changes on the machine the agent runs on, and what it does not. */
export const GITHUB_GRANT_NOTES = [
  APP_NOTE,
  'Replaces your GitHub login for this agent over HTTPS. SSH still uses your keys.',
  "On your computer, the agent can still use anything you're signed in to.",
  'Not available on Windows yet.',
] as const;
