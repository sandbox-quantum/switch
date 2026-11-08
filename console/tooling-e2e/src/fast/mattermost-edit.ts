import { expect } from 'vitest';
import type { AgentEvent } from '../clients/switch-client.ts';
import { WRITABLE, type FastScenario } from './scenario.ts';

/**
 * A person editing their post in a real Mattermost, with no Switch Console and
 * no model in the loop: what Mattermost really sends for an edit comes through
 * the bridge as one edit event, to the agent the message addressed and to no
 * other, and it never reads as a new message.
 */
export const mattermostEdit: FastScenario = {
  header: {
    id: 'mattermost-edit',
    covers: ['GET /agents/{agent_id}/notifications'],
    lane: 'fast',
    environments: WRITABLE,
    owner: 'platform',
    requires: ['mattermost'],
  },
  async run({ fixtures, names, switchClient, mattermost }) {
    const addressed = await fixtures.agent('edited');
    const bystander = await fixtures.agent('bystander');
    const bridged = await fixtures.mattermostRoom('room', [addressed, bystander]);

    const marker = names.marker('edit');
    const posted = await mattermost!.post({
      channelId: bridged.channel.id,
      message: `@${addressed.name} Approve sample ${marker}`,
    });
    const original = await switchClient.waitForNotification(
      addressed,
      (event) => event.type === 'message' && JSON.stringify(event).includes(marker),
      120_000
    );
    expect(original.match, 'the message never reached the agent').not.toBeNull();
    const messageId = original.match!.payload?.message_id;

    // The edit names the other agent, which addresses nobody new.
    const reworded = `@${bystander.name} Decline sample ${marker}`;
    await mattermost!.editPost(posted.id, reworded);

    const isEdit = (event: AgentEvent) =>
      event.type === 'message_edit' && JSON.stringify(event).includes(marker);
    const edit = await switchClient.waitForNotification(addressed, isEdit, 120_000);
    expect(
      edit.match,
      `the edit never reached the agent; saw ${JSON.stringify(edit.seen).slice(0, 800)}`
    ).not.toBeNull();
    expect(edit.match!.room_id).toBe(bridged.room.id);
    expect(edit.match!.payload?.message_id).toBe(messageId);
    expect(edit.match!.payload?.new_body).toContain('Decline sample');

    const other = await switchClient.waitForNotification(bystander, isEdit, 5_000);
    expect(other.match, 'the edit reached an agent the message did not address').toBeNull();
    expect(other.seen.filter((event) => JSON.stringify(event).includes(marker))).toEqual([]);
  },
};
