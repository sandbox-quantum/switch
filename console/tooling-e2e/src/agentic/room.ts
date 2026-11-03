import { stringify } from 'yaml';
import type { NameScope } from '../core/run.ts';
import { message } from '../core/suite.ts';
import { waitForBridgeReady } from '../fixtures/fixtures.ts';
import { waitForSession, type Harness } from '../provider/harness.ts';
import type { AgenticScenario } from './scenario-file.ts';

/**
 * A scenario's own room, provisioned from its `room:` the way an agent's
 * `create_room_from_yaml` would be (through the gateway's `POST
 * /rooms/from-yaml`), with the lane's agent, the bridge witness and the
 * harness's human as members.
 *
 * Returned as a harness pointed at the new room and channel, once the bridge
 * carries messages there and Switch reports the agent's session in it; and a
 * removal that never throws, so a failed teardown is reported without hiding
 * the scenario's result.
 */
export interface ScenarioRoom {
  harness: Harness;
  remove: (log: (message: string) => void) => Promise<void>;
}

export async function provisionScenarioRoom(
  base: Harness,
  scenario: AgenticScenario,
  names: NameScope,
  sessionDeadlineMs: number
): Promise<ScenarioRoom> {
  if (scenario.room === null) throw new Error(`${scenario.header.id} declares no room`);
  const { switch: switchClient, mattermost } = base;
  const bridge = await switchClient.defaultBridge('mattermost');
  const document = {
    room: {
      description: `${scenario.header.id}: Switch end-to-end agentic scenario (run ${base.runId}). Safe to delete.`,
      ...scenario.room,
      name: names.name('room'),
      bridge: bridge.displayName,
      agents: [base.agent.name, base.witness.name],
      users: [base.human.username],
    },
  };
  const room = await switchClient.createRoomFromYaml(stringify(document));
  const channelId = room.externalChannelId;
  const remove = async (log: (message: string) => void): Promise<void> => {
    try {
      await switchClient.deleteRoom(room.id);
    } catch (error) {
      log(`could not delete room ${room.name} (${room.id}) — delete it by hand: ${message(error)}`);
    }
    if (channelId === null) return;
    try {
      const left = await mattermost.getChannel(channelId);
      if (!left.delete_at) await mattermost.archiveChannel(channelId);
    } catch (error) {
      log(
        `could not archive Mattermost channel ${channelId} of room ${room.name} — archive it by hand: ${message(error)}`
      );
    }
  };
  try {
    if (channelId === null) {
      throw new Error(`Room ${room.id} was provisioned without a Mattermost channel.`);
    }
    const channel = await mattermost.getChannel(channelId);
    await waitForBridgeReady({
      switchClient,
      mattermost,
      agent: base.witness,
      room,
      channel,
      runId: base.runId,
    });
    const harness: Harness = { ...base, room, channel };
    await waitForSession(harness, sessionDeadlineMs);
    return { harness, remove };
  } catch (error) {
    await remove(console.warn);
    throw error;
  }
}
