import type { GitHubConnection } from '@shared/core/switch-servers/github-connection';

/**
 * What an agent's GitHub access names: one installation of the App, some of
 * its repositories, and whether the agent may push. Pure: the picker, the
 * Add agent panel and the agent's own form all build on this.
 */

export type GitHubAccess = 'read' | 'write';

export const GITHUB_ACCESS_OPTIONS = [
  { value: 'read', label: 'Read' },
  { value: 'write', label: 'Read and push' },
] as const;

export type ConnectedGitHub = Extract<GitHubConnection, { status: 'connected' }>;
export type GitHubInstallation = ConnectedGitHub['installations'][number];
export type GitHubRepository = GitHubInstallation['repositories'][number];

/** The connection where it is one, so its installations can be read. */
export function connectedGitHub(data: GitHubConnection | undefined): ConnectedGitHub | null {
  return data !== undefined && data.status === 'connected' ? data : null;
}

export interface GitHubGrantChoice {
  installationId: number | null;
  repositoryIds: number[];
  access: GitHubAccess;
}

/** Said while nothing is chosen: there is nothing yet to add an agent to. */
export const NOTHING_CHOSEN_NOTE =
  'No repositories chosen yet. Choose some, then add the agents that should use them.';

/** The choice to start from: the first installation, no repositories, read only. */
export function emptyGitHubGrant(github: GitHubConnection | undefined): GitHubGrantChoice {
  const installation = github?.status === 'connected' ? github.installations[0] : undefined;
  return { installationId: installation?.id ?? null, repositoryIds: [], access: 'read' };
}

export function chosenInstallation(
  github: ConnectedGitHub,
  choice: GitHubGrantChoice
): GitHubInstallation | undefined {
  return github.installations.find((candidate) => candidate.id === choice.installationId);
}

/** The repositories the choice names, in the order chosen, by what the connection knows of them. */
export function chosenRepositories(
  github: ConnectedGitHub,
  choice: GitHubGrantChoice
): { id: number; name: string }[] {
  const installation = chosenInstallation(github, choice);
  return choice.repositoryIds.map((id) => ({
    id,
    name: installation?.repositories.find((r) => r.id === id)?.name ?? `repository ${id}`,
  }));
}

/** The resources a grant with this choice sends; null until it names a repository. */
export function githubGrantResources(
  choice: GitHubGrantChoice
): { installation_id: number; repository_ids: number[] } | null {
  if (choice.installationId === null || choice.repositoryIds.length === 0) return null;
  return { installation_id: choice.installationId, repository_ids: choice.repositoryIds };
}

/**
 * The choice as what an agent gets: "read access to 3 repositories", "read
 * and push access to 1 repository under example-org". The account is named
 * only where there is more than one to tell apart. Null while nothing is
 * chosen.
 */
export function githubChoiceSummary(
  github: ConnectedGitHub,
  choice: GitHubGrantChoice
): string | null {
  const count = choice.repositoryIds.length;
  if (count === 0) return null;
  const access = choice.access === 'write' ? 'read and push access to' : 'read access to';
  const installation = chosenInstallation(github, choice);
  const where =
    github.installations.length > 1 && installation ? ` under ${installation.account}` : '';
  return `${access} ${count} ${count === 1 ? 'repository' : 'repositories'}${where}`;
}

/** Those of the installation's repositories matching `query`, leaving out `exclude`. */
export function matchingRepositories(
  installation: GitHubInstallation,
  query: string,
  exclude: number[]
): GitHubRepository[] {
  const needle = query.trim().toLowerCase();
  return installation.repositories.filter(
    (repository) =>
      !exclude.includes(repository.id) &&
      (needle === '' || repository.name.toLowerCase().includes(needle))
  );
}

export function withRepository(choice: GitHubGrantChoice, id: number): GitHubGrantChoice {
  return choice.repositoryIds.includes(id)
    ? choice
    : { ...choice, repositoryIds: [...choice.repositoryIds, id] };
}

export function withoutRepository(choice: GitHubGrantChoice, id: number): GitHubGrantChoice {
  return { ...choice, repositoryIds: choice.repositoryIds.filter((other) => other !== id) };
}

/** Every repository of the chosen installation, keeping the order already chosen. */
export function withEveryRepository(
  github: ConnectedGitHub,
  choice: GitHubGrantChoice
): GitHubGrantChoice {
  const installation = chosenInstallation(github, choice);
  if (!installation) return choice;
  const rest = installation.repositories
    .map((r) => r.id)
    .filter((id) => !choice.repositoryIds.includes(id));
  return { ...choice, repositoryIds: [...choice.repositoryIds, ...rest] };
}

/** The choice for another installation: its repositories are different ones. */
export function withInstallation(choice: GitHubGrantChoice, id: number | null): GitHubGrantChoice {
  return { ...choice, installationId: id, repositoryIds: [] };
}
