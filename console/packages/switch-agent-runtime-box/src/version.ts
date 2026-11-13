import { artifactVersion } from './artifacts';

/**
 * This artifact's own release version (CHOO-1865).
 *
 * A semver says *where* an artifact is — which release you are running. It says
 * nothing about whether it can talk to anything; that is what the contract
 * revisions in `./artifacts` are for. The two move independently and must never
 * be derived from one another.
 *
 * Derived from `artifacts.yaml` rather than written here, so it cannot drift
 * from package.json. It used to be a literal kept honest by a test, which is
 * better than the comment it replaced but still a second copy to get wrong.
 */
export const RUNTIME_VERSION = artifactVersion('agent-runtime');

/** The artifact name this package declares itself as to Switch. */
export const RUNTIME_ARTIFACT = 'agent-runtime';
