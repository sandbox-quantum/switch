import {
  type ConnectionGrant,
  MAX_GRANTED_REPOSITORIES,
} from '@shared/core/switch-servers/connection-grants';

export const GITHUB_SLUG = 'github';

/** What a cloud agent can reach through one GitHub App installation. */
export type GitHubAccess =
  | { kind: 'none' }
  | { kind: 'all' }
  /** Empty while the owner is still choosing; a definition never carries it empty. */
  | { kind: 'selected'; repositories: number[] };

/** The access the grants give through one installation. */
export function gitHubAccess(grants: ConnectionGrant[], installationId: number): GitHubAccess {
  const installation = grants
    .find((grant) => grant.slug === GITHUB_SLUG)
    ?.installations.find((candidate) => candidate.installation_id === installationId);
  if (!installation) return { kind: 'none' };
  return installation.repositories === 'all'
    ? { kind: 'all' }
    : { kind: 'selected', repositories: installation.repositories };
}

/**
 * The grants with one installation's access replaced. An installation with no
 * access is left out, and so is the GitHub grant once no installation is left.
 */
export function withGitHubAccess(
  grants: ConnectionGrant[],
  installationId: number,
  access: GitHubAccess
): ConnectionGrant[] {
  const current = grants.find((grant) => grant.slug === GITHUB_SLUG)?.installations ?? [];
  const next =
    access.kind === 'none'
      ? null
      : {
          installation_id: installationId,
          repositories: access.kind === 'all' ? ('all' as const) : access.repositories,
        };
  const exists = current.some((candidate) => candidate.installation_id === installationId);
  const installations = exists
    ? current.flatMap((candidate) =>
        candidate.installation_id !== installationId ? [candidate] : next ? [next] : []
      )
    : next
      ? [...current, next]
      : current;
  const others = grants.filter((grant) => grant.slug !== GITHUB_SLUG);
  if (installations.length === 0) return others;
  const index = grants.findIndex((grant) => grant.slug === GITHUB_SLUG);
  const github = { slug: GITHUB_SLUG, installations };
  if (index === -1) return [...grants, github];
  return grants.map((grant, i) => (i === index ? github : grant));
}

/**
 * Why the grants cannot be saved as they are, or null when they can. Names the
 * installation by its account when the caller knows it.
 */
export function connectionGrantsProblem(
  grants: ConnectionGrant[],
  accountOf: (installationId: number) => string | null
): string | null {
  for (const grant of grants)
    for (const installation of grant.installations) {
      if (installation.repositories === 'all') continue;
      const account = accountOf(installation.installation_id) ?? 'a GitHub account';
      if (installation.repositories.length === 0)
        return `Choose at least one repository for ${account}, or give it no access.`;
      if (installation.repositories.length > MAX_GRANTED_REPOSITORIES)
        return `Choose at most ${MAX_GRANTED_REPOSITORIES} repositories for ${account}, or give it all of them.`;
    }
  return null;
}
