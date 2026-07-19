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

/** The Switch core (agent bridge) API, published on :8000 — what a connector's
 * `SWITCH_API_ENDPOINT` points at. */
export const LOCAL_SERVER_API_URL = 'http://localhost:8000';

/** The operator gateway: the nginx dashboard that serves the web UI and proxies
 * `/gateway` to switch-core. switchdash's management calls go to
 * `${gatewayUrl}/gateway`, and "Open web app" opens this URL. Published on :3300
 * (not the compose default :3000) because switchdash's own renderer dev server
 * binds :3000 — sharing it makes the browser hit switchdash instead of the
 * gateway. The compose maps `${GATEWAY_HOST_PORT:-3000}:3000`; the generated
 * `.env` sets GATEWAY_HOST_PORT=3300 to match this URL. */
export const LOCAL_SERVER_GATEWAY_URL = 'http://localhost:3300';

/** Host port the gateway container is published on for the managed stack; fed to
 * the compose `${GATEWAY_HOST_PORT}` interpolation. Kept in sync with the port in
 * {@link LOCAL_SERVER_GATEWAY_URL}. */
export const LOCAL_SERVER_GATEWAY_HOST_PORT = '3300';

/** Compose profiles switchdash enables: `collab` (Mattermost bridge + seeder) so
 * the stack has a working collaboration bridge, and `gateway` so the operator
 * web dashboard is available at :3000. */
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
