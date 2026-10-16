import type { ConnectedGitHub } from './github-grant';

export const SSO_HIDDEN_NOTE =
  'An organization’s single sign-on hides its installation of the app from this GitHub connection. Disconnect and connect GitHub again, and authorize the organization when GitHub asks.';
export const NO_REPOSITORIES_NOTE =
  'Choose repositories on GitHub to finish setup. Your organization may require an owner’s approval.';

/** The count beside the heading: how many repositories, across how many accounts. */
export function repositoriesSummary(github: ConnectedGitHub): string {
  const total = github.installations.reduce((n, i) => n + i.repositories.length, 0);
  const accounts = github.installations.length;
  const repositories = `${total} ${total === 1 ? 'repository' : 'repositories'}`;
  return accounts > 1 ? `${repositories} across ${accounts} accounts` : repositories;
}

/** The section's action: choosing the first time, changing after. */
export function repositoriesActionLabel(github: ConnectedGitHub): string {
  return github.installations.some((i) => i.repositories.length > 0)
    ? 'Change repositories'
    : 'Choose repositories';
}
