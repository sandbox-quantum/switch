/**
 * The variable an agents controller sets in each agent host's environment to
 * mark everything that host starts as that agent's (`owner-marker.ts` in the
 * controller). Its value is a per-agent secret the controller derives, so a
 * process proves whose it is by carrying it, not by its name or command line.
 */
export const OWNER_MARKER_ENV = 'SWITCH_OWNER_MARKER';

/**
 * `env` for a provider CLI, carrying the owner marker of the host it runs in
 * (`hostEnv`) and no other. The CLI's environment is built from a list of
 * names that leaves `SWITCH_*` out, so the marker is passed on here, last, so
 * an agent's own configured variables cannot replace it; and one configured
 * where the host has none is removed, so an agent's settings cannot plant it.
 */
export function withOwnerMarker(
  env: Record<string, string>,
  hostEnv: NodeJS.ProcessEnv
): Record<string, string> {
  const { [OWNER_MARKER_ENV]: _configured, ...rest } = env;
  const marker = hostEnv[OWNER_MARKER_ENV];
  return marker ? { ...rest, [OWNER_MARKER_ENV]: marker } : rest;
}

/**
 * The marker for Claude Code's command-line settings, which outrank a
 * project's or user's settings file: an `env` there naming the marker (one an
 * agent's code wrote, say) would otherwise replace the inherited one for
 * everything the CLI runs. Empty when there is no marker to pass on.
 */
export function ownerMarkerSettingsEnv(env: Record<string, string>): Record<string, string> {
  const marker = env[OWNER_MARKER_ENV];
  return marker ? { [OWNER_MARKER_ENV]: marker } : {};
}

/**
 * MCP server specs with any marker their own `env` names removed: a stdio
 * server configured for an agent must not start with a marker the agent
 * chose. One it is forwarded (`envVars`) is the host's own and stays.
 */
export function withoutPlantedMarkers<T extends object>(
  servers: Record<string, T>
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, spec]) => {
      const env = (spec as { env?: Record<string, string> }).env;
      if (!env || !(OWNER_MARKER_ENV in env)) return [name, spec];
      const { [OWNER_MARKER_ENV]: _planted, ...kept } = env;
      return [name, { ...spec, env: kept }];
    })
  );
}
