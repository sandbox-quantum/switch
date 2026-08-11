import { USER_DATA_DIR_NAME } from '@shared/app-identity';

/**
 * Fixed coordinates for the managed local stack. These mirror the ports and
 * hosts baked into the bundled standalone compose (resources/…pinned.yml): the
 * compose file is the contract, and these constants are how the rest of
 * Switch Console addresses the resulting server.
 */

/**
 * `docker compose --project-name` for the managed stack on this machine, so its
 * containers and volumes are isolated and discoverable across app restarts.
 *
 * Scoped per build. Each build keeps its generated stack secrets in its own
 * userData dir (see USER_DATA_DIR_NAME), but Postgres only honours
 * POSTGRES_PASSWORD when it initialises a fresh volume — so builds sharing one
 * project name share `pgdata` and every build except the one that created it
 * fails authentication. They also fight over the containers themselves,
 * recreating each other's stack on start. Stable keeps the original name so
 * existing installs stay attached to the stack they already have.
 */
export const LOCAL_SERVER_PROJECT_NAME =
  USER_DATA_DIR_NAME === 'switchdash' ? 'switchdash-local' : `${USER_DATA_DIR_NAME}-local`;

/** `docker compose --project-name` for a managed stack on a remote host. Each
 * remote host runs its own Docker daemon, so one name per build is enough to
 * isolate + rediscover the stack there — per build for the same reason as
 * {@link LOCAL_SERVER_PROJECT_NAME}, since two builds can target one host. */
export const REMOTE_SERVER_PROJECT_NAME =
  USER_DATA_DIR_NAME === 'switchdash' ? 'switchdash-remote' : `${USER_DATA_DIR_NAME}-remote`;

/** File names of the compose file and generated `.env` inside the host working
 * dir. Kept relative so `docker compose -f <name>` resolves against the working
 * dir on either host, independent of its absolute path. */
export const COMPOSE_FILE_NAME = 'standalone-docker-compose.yml';
export const ENV_FILE_NAME = '.env';

/** Display name of the auto-registered server record. */
export const LOCAL_SERVER_NAME = 'Local Switch server';

// The managed server's API and gateway URLs are NOT fixed constants: their host
// ports are chosen from whatever is free on the machine (see ports.ts) so the
// stack never collides with a dev's existing services. Resolve them via
// gatewayUrlFor()/apiUrlFor() from the persisted port set.

/** Compose profiles Switch Console enables: `collab` (Mattermost bridge + seeder) so
 * the stack has a working collaboration bridge, and `gateway` so the operator
 * web dashboard is available. */
export const LOCAL_SERVER_PROFILES = ['collab', 'gateway'] as const;

/** Registry the release images are published to and pulled from. */
export const GHCR_REGISTRY = 'ghcr.io';

/** The gateway admin account the stack seeds (GATEWAY_ADMIN_EMAIL). Switch Console
 * generates its password, so it also auto-signs-in with these on start rather
 * than making the user type a secret they never saw. */
export const LOCAL_SERVER_ADMIN_EMAIL = 'admin@switch.local';

/** Host interface the managed stack's published ports bind to, fed to the
 * compose `${SWITCH_BIND_ADDR}` interpolation. Loopback so the single-user local
 * stack is never exposed to the LAN (the standalone compose defaults to all
 * interfaces for repo users who may want remote access). */
export const LOCAL_SERVER_BIND_ADDR = '127.0.0.1';

/** Mattermost team the stack's seeder creates (MATTERMOST_TEAM_NAME). Named
 * rather than inlined because it is also what a link into the bundled
 * Mattermost has to path through — the two must not drift. */
export const LOCAL_SERVER_MATTERMOST_TEAM = 'switch';

/** The human account the stack's seeder creates (MATTERMOST_USER), paired with
 * the generated `mattermostUserPassword`. Three places depend on it being the
 * name the seeder actually used — the generated env, the embed's silent login,
 * and the sign-in Switch Console shows the user — so it is named once here. */
export const LOCAL_SERVER_MATTERMOST_USER = 'user';
