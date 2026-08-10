import composeYaml from './resources/standalone-docker-compose.pinned.yml?raw';

/** The standalone compose bundled into the app (pinned to
 * COMPATIBLE_SWITCH_VERSION), inlined at build time. Written to the host working
 * dir on every start (via `ServerHost.writeFile`) so `docker compose -f <name>`
 * can run it — Docker cannot read a file inside the packaged app bundle, and a
 * remote host cannot read the desktop's filesystem at all. */
export function bundledComposeYaml(): string {
  return composeYaml;
}
