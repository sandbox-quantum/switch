import type { NameScope } from '../core/run.ts';
import { message } from '../core/suite.ts';
import { waitForSession, type Harness } from '../provider/harness.ts';
import type { AgenticScenario } from './scenario-file.ts';

/**
 * A scenario's own room, made from its `room:` through the gateway's `POST
 * /rooms` as an internal-only room (no messaging app, even on an environment
 * with a default one), with the lane's agent, the witness and the harness's
 * person as members.
 *
 * Returned as a harness pointed at the new room, once Switch reports the
 * agent's session in it; and a removal that never throws, so a failed teardown
 * is reported without hiding the scenario's result.
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
  const { switch: switchClient } = base;
  const { description, instructions, roles } = scenario.room;
  const room = await switchClient.createRoom({
    name: names.name('room'),
    description:
      typeof description === 'string'
        ? description
        : `${scenario.header.id}: Switch end-to-end agentic scenario (run ${base.runId}). Safe to delete.`,
    instructions,
    roles,
    bridgeId: null,
    agentNames: [base.agent.name, base.witness.name],
    userNames: [base.env.switch.gatewayAdminEmail],
  });
  const remove = async (log: (message: string) => void): Promise<void> => {
    try {
      await switchClient.deleteRoom(room.id);
    } catch (error) {
      log(`could not delete room ${room.name} (${room.id}) — delete it by hand: ${message(error)}`);
    }
  };
  try {
    const harness: Harness = { ...base, room };
    await waitForSession(harness, sessionDeadlineMs);
    return { harness, remove };
  } catch (error) {
    await remove(console.warn);
    throw error;
  }
}
