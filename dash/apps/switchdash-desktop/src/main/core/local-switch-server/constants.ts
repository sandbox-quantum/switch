/**
 * Fixed coordinates for the managed local stack. These mirror the ports and
 * hosts baked into the bundled standalone compose (resources/…pinned.yml): the
 * compose file is the contract, and these constants are how the rest of
 * switchdash addresses the resulting server.
 */

/** `docker compose --project-name` for the managed stack, so its containers and
 * volumes are isolated and discoverable across app restarts. */
export const LOCAL_SERVER_PROJECT_NAME = 'switchdash-local';

/** Display name of the auto-registered server record. */
export const LOCAL_SERVER_NAME = 'Local Switch server';

/** switch-core (agent bridge) is published on :8000 by the compose file. It also
 * serves the `/gateway` management API, so the gateway and API URLs coincide —
 * switchdash IS the operator frontend, so the compose `gateway` profile (the
 * nginx dashboard) is not brought up. */
export const LOCAL_SERVER_API_URL = 'http://localhost:8000';
export const LOCAL_SERVER_GATEWAY_URL = 'http://localhost:8000';

/** Compose profiles switchdash enables. Mattermost (the `collab` profile) is on
 * by default so the local stack has a working collaboration bridge. */
export const LOCAL_SERVER_PROFILES = ['collab'] as const;

/** Registry the private release images live in until the public-repo flip
 * (CHOO-1260); used for the authenticated `docker login` before pulling. */
export const GHCR_REGISTRY = 'ghcr.io';
