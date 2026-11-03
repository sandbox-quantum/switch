/**
 * Remove artefacts that interrupted runs left behind: Switch agents, Switch
 * rooms and Mattermost channels named the way the harness names things
 * (`e2e-<runId><scope>-<role>`, see `isHarnessArtifact`) and older than
 * `--older-than <minutes>`.
 *
 * Scoped strictly to that shape, not just the `e2e-` prefix: people name their
 * own test agents and rooms `e2e-…` too. The script prints everything it
 * touches. The age floor is
 * what lets a scheduled wipe of a deployed environment run while a suite is in
 * progress: a run's own artefacts are younger than the floor, so it is left
 * alone. Pick a floor longer than the longest run; `0` takes everything, which
 * is only right when nothing else is running against the server.
 *
 *     SWITCH_E2E_LANE=fast node --experimental-strip-types src/cleanup.ts --older-than 120
 */
import { isHarnessArtifact } from './core/run.ts';
import { message, resolveLane } from './core/suite.ts';

export async function cleanup(
  olderThanMinutes: number,
  log: (message: string) => void = console.log
): Promise<void> {
  const lane = await resolveLane('fast');
  if (!lane.target) throw new Error(`Cannot clean up: ${lane.skip}`);
  const { env, switchClient, mattermost } = lane.target;
  const cutoff = Date.now() - olderThanMinutes * 60_000;
  const stale = (name: string, createdMs: number): boolean =>
    isHarnessArtifact(name) && createdMs <= cutoff;
  let failures = 0;

  for (const room of await switchClient.listRooms()) {
    if (!stale(room.name, timestampMs(room.createdAt))) continue;
    try {
      await switchClient.deleteRoom(room.id);
      log(`deleted room ${room.name} (${room.id})`);
    } catch (error) {
      failures += 1;
      log(`could not delete room ${room.name}: ${message(error)}`);
    }
  }

  for (const agent of await switchClient.listAgents()) {
    if (!stale(agent.name, timestampMs(agent.createdAt))) continue;
    try {
      await switchClient.deleteAgentByName(agent.name);
      log(`deleted agent ${agent.name} (${agent.id})`);
    } catch (error) {
      failures += 1;
      log(`could not delete agent ${agent.name}: ${message(error)}`);
    }
  }

  if (!mattermost || !env.mattermost) {
    log('no Mattermost configured — channels not checked');
  } else {
    const team = await mattermost.findTeam(env.mattermost.team);
    for (const channel of await mattermost.listTeamChannels(team.id)) {
      if (!stale(channel.name, channel.create_at)) continue;
      try {
        await mattermost.archiveChannel(channel.id);
        log(`archived channel ${channel.name} (${channel.id})`);
      } catch (error) {
        failures += 1;
        log(`could not archive channel ${channel.name}: ${message(error)}`);
      }
    }
  }

  if (failures > 0) throw new Error(`${failures} artefact(s) could not be removed; see above.`);
}

/**
 * A server timestamp in epoch milliseconds. One without a UTC offset is
 * refused: JavaScript would read it as local time, and an age floor computed
 * from that is off by the machine's timezone.
 */
export function timestampMs(raw: string): number {
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(raw.trim())) {
    throw new Error(`Timestamp '${raw}' carries no UTC offset; cannot tell its age.`);
  }
  const ms = Date.parse(raw.trim().replace(' ', 'T'));
  if (Number.isNaN(ms)) throw new Error(`Cannot parse timestamp '${raw}'.`);
  return ms;
}

export function olderThanFrom(argv: readonly string[]): number {
  const index = argv.indexOf('--older-than');
  const raw = index === -1 ? undefined : argv[index + 1];
  const minutes = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new Error('Pass --older-than <minutes>: only artefacts older than that are removed.');
  }
  return minutes;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  Promise.resolve()
    .then(() => cleanup(olderThanFrom(process.argv.slice(2))))
    .catch((error: unknown) => {
      console.error(message(error));
      process.exitCode = 1;
    });
}
