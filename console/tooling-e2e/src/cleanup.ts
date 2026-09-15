/**
 * Remove artefacts a crashed or interrupted run left behind: Switch agents named
 * `e2e-*`, Switch rooms named `e2e-*`, and Mattermost channels named `e2e-*`.
 *
 * Scoped strictly to the `e2e-` prefix — an operator's real agents (`switchdev`
 * and friends) and their rooms are never in scope, and the script prints
 * everything it is about to touch.
 *
 *     SWITCH_E2E=1 node --experimental-strip-types src/cleanup.ts
 */
import { loadEnv } from './env.ts';
import { MattermostClient } from './mattermost-client.ts';
import { SwitchClient } from './switch-client.ts';

const PREFIX = 'e2e-';

export async function cleanup(log: (message: string) => void = console.log): Promise<void> {
  const env = loadEnv();
  const switchClient = new SwitchClient({
    apiUrl: env.switchApiUrl,
    registrationToken: env.agentRegistrationToken,
    gatewayAdminEmail: env.gatewayAdminEmail,
    gatewayAdminPassword: env.gatewayAdminPassword,
  });
  const mattermost = new MattermostClient({ url: env.mattermostUrl, token: env.mattermostToken });

  for (const room of await switchClient.listRooms()) {
    if (!room.name.startsWith(PREFIX)) continue;
    try {
      await switchClient.deleteRoom(room.id);
      log(`deleted room ${room.name} (${room.id})`);
    } catch (error) {
      log(`could not delete room ${room.name}: ${message(error)}`);
    }
  }

  for (const agent of await switchClient.listAgents()) {
    if (!agent.name.startsWith(PREFIX)) continue;
    try {
      await switchClient.deleteAgentByName(agent.name);
      log(`deleted agent ${agent.name} (${agent.id})`);
    } catch (error) {
      log(`could not delete agent ${agent.name}: ${message(error)}`);
    }
  }

  const team = await mattermost.findTeam(env.mattermostTeam);
  for (const channel of await mattermost.listTeamChannels(team.id)) {
    if (!channel.name.startsWith(PREFIX)) continue;
    try {
      await mattermost.archiveChannel(channel.id);
      log(`archived channel ${channel.name} (${channel.id})`);
    } catch (error) {
      log(`could not archive channel ${channel.name}: ${message(error)}`);
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cleanup().catch((error: unknown) => {
    console.error(message(error));
    process.exitCode = 1;
  });
}
