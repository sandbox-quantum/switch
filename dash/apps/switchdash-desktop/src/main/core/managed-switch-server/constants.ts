/**
 * Fixed coordinates for the managed local stack. These mirror the ports and
 * hosts baked into the bundled standalone compose (resources/…pinned.yml): the
 * compose file is the contract, and these constants are how the rest of
 * switchdash addresses the resulting server.
 */

/** `docker compose --project-name` for the managed stack on this machine, so its
 * containers and volumes are isolated and discoverable across app restarts. */
export const LOCAL_SERVER_PROJECT_NAME = 'switchdash-local';

/** `docker compose --project-name` for a managed stack on a remote host. Each
 * remote host runs its own Docker daemon, so a single fixed name is enough to
 * isolate + rediscover the stack there. */
export const REMOTE_SERVER_PROJECT_NAME = 'switchdash-remote';

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

/** Compose profiles switchdash enables: `collab` (Mattermost bridge + seeder) so
 * the stack has a working collaboration bridge, and `gateway` so the operator
 * web dashboard is available. */
export const LOCAL_SERVER_PROFILES = ['collab', 'gateway'] as const;

/** Registry the private release images live in until the public-repo flip
 * (CHOO-1260); used for the authenticated `docker login` before pulling. */
export const GHCR_REGISTRY = 'ghcr.io';

/** The gateway admin account the stack seeds (GATEWAY_ADMIN_EMAIL). switchdash
 * generates its password, so it also auto-signs-in with these on start rather
 * than making the user type a secret they never saw. */
export const LOCAL_SERVER_ADMIN_EMAIL = 'admin@switch.local';

/** Host interface the managed stack's published ports bind to, fed to the
 * compose `${SWITCH_BIND_ADDR}` interpolation. Loopback so the single-user local
 * stack is never exposed to the LAN (the standalone compose defaults to all
 * interfaces for repo users who may want remote access). */
export const LOCAL_SERVER_BIND_ADDR = '127.0.0.1';
