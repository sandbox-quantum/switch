import { expect } from 'vitest';
import { eventText } from '../clients/switch-client.ts';
import { WRITABLE, type FastScenario } from './scenario.ts';

/**
 * An edit made on Mattermost reaches the agent the message did, as the
 * message's new text, and history shows the message as it now reads.
 *
 * 1. post `@agent …` as a human and wait for the agent's notification;
 * 2. edit the post and confirm a `message_edit` reaches the agent, naming the
 *    message it is the new text of, with the delivery's own `addressed` flag;
 * 3. `read_context` shows the message with the edited text and when it was
 *    edited, and no entry for the edit itself;
 * 4. an edit that names another agent reaches that agent not at all: an edit
 *    never addresses anyone the message did not.
 */
export const mattermostMessageEdit: FastScenario = {
  header: {
    id: 'mattermost-message-edit',
    covers: ['GET /agents/{agent_id}/notifications', 'read_context'],
    lane: 'fast',
    environments: WRITABLE,
    owner: 'platform',
    requires: ['mattermost'],
  },
  async run({ fixtures, names, switchClient, mattermost, log }) {
    const agent = await fixtures.agent('edt');
    const bystander = await fixtures.agent('byst');
    const bridged = await fixtures.mattermostRoom('room', [agent, bystander]);

    const marker = names.marker('edit');
    const posted = await mattermost!.post({
      channelId: bridged.channel.id,
      message: `@${agent.name} look at teh file ${marker}`,
    });
    log(`posted ${posted.id} as ${bridged.human.username}`);

    const original = await switchClient.waitForNotification(
      agent,
      (event) => event.type === 'message' && eventText(event).includes(marker),
      120_000
    );
    expect(
      original.match,
      `the message never reached the agent; saw ${JSON.stringify(original.seen).slice(0, 800)}`
    ).not.toBeNull();
    const messageId = original.match!.payload!.message_id!;

    // ── the edit, naming the other agent instead ─────────────────────────────
    const edited = await mattermost!.edit(
      posted.id,
      `@${bystander.name} look at the file ${marker}`
    );
    log(`edited ${edited.id} at ${edited.edit_at}`);

    const edit = await switchClient.waitForNotification(
      agent,
      (event) => event.type === 'message_edit' && eventText(event).includes('the file'),
      120_000
    );
    expect(
      edit.match,
      `the edit never reached the agent; saw ${JSON.stringify(edit.seen).slice(0, 800)}`
    ).not.toBeNull();
    expect(edit.match!.room_id).toBe(bridged.room.id);
    expect(edit.match!.payload).toMatchObject({
      addressed: true,
      replaces_message_id: messageId,
      body: `@${bystander.name} look at the file ${marker}`,
    });
    expect(edit.match!.payload!.message_id).not.toBe(messageId);

    // ── history shows the message as it now reads ────────────────────────────
    const history = await switchClient.callOperation<{
      threads: { root: { id: string; body: string | null; edited_at?: number } }[];
    }>(agent, 'read_context', { room_id: bridged.room.id, limit: 50 });
    const root = history.threads
      .map((thread) => thread.root)
      .find((entry) => entry.id === messageId);
    expect(root, `history has no entry for ${messageId}`).toBeDefined();
    expect(root!.body).toContain('look at the file');
    expect(root!.body).not.toContain('teh');
    expect(root!.edited_at).toBeGreaterThan(0);
    expect(
      history.threads.some((thread) => thread.root.id === edit.match!.payload!.message_id)
    ).toBe(false);

    // ── the agent the edit names, which the message did not, hears nothing ───
    const stray = await switchClient.waitForNotification(
      bystander,
      (event) => eventText(event).includes(marker),
      5_000
    );
    expect(
      stray.match,
      `the edit reached ${bystander.name}: ${JSON.stringify(stray.match)}`
    ).toBeNull();
  },
};
