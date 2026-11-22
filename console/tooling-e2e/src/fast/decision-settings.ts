import { expect } from 'vitest';
import { SwitchHttpError } from '../clients/switch-client.ts';
import type { FastScenario } from './scenario.ts';

const FLAG = 'decision_routing';

/**
 * A workspace's decision routing settings and a room's auto-route switch,
 * through the gateway as the workspace's admin:
 *
 * 1. the settings read back with where they come from (the server default
 *    until the workspace chooses);
 * 2. Test runs without saving anything and says why it can't decide when
 *    nothing is configured;
 * 3. choosing "none" turns auto-route off for the workspace, so a room can't
 *    turn it on and says why;
 * 4. resetting goes back to the server default.
 *
 * On a server with the `decision_routing` flag off none of these routes is
 * mounted, so instead it checks that each one answers 404: a server without
 * auto-route offers nothing of it.
 *
 * It changes the workspace's setting while it runs, so it stays off shared
 * environments.
 */
export const decisionSettings: FastScenario = {
  header: {
    id: 'decision-settings',
    covers: [
      'GET /gateway/decision-settings',
      'PUT /gateway/decision-settings',
      'DELETE /gateway/decision-settings',
      'POST /gateway/decision-settings/test',
      'PUT /gateway/rooms/{room_id}/auto-route',
    ],
    lane: 'fast',
    environments: ['ephemeral', 'local'],
    owner: 'platform',
    requires: [],
  },
  async run({ fixtures, switchClient, log }) {
    if (!(await switchClient.enabledFeatureFlags()).has(FLAG)) {
      const agent = await fixtures.agent('dragent');
      const room = await fixtures.internalRoom('drroom', [agent]);
      const calls: [string, () => Promise<unknown>][] = [
        ['GET /gateway/decision-settings', () => switchClient.decisionSettings()],
        [
          'PUT /gateway/decision-settings',
          () => switchClient.saveDecisionSettings({ backend: 'none' }),
        ],
        ['DELETE /gateway/decision-settings', () => switchClient.resetDecisionSettings()],
        [
          'POST /gateway/decision-settings/test',
          () => switchClient.testDecisionSettings({ backend: 'default' }),
        ],
        [
          'PUT /gateway/rooms/{room_id}/auto-route',
          () => switchClient.setRoomAutoRoute(room.id, { on: false }),
        ],
      ];
      for (const [route, call] of calls) {
        const error = await call().then(
          () => null,
          (thrown: unknown) => thrown
        );
        expect(error, route).toBeInstanceOf(SwitchHttpError);
        expect((error as SwitchHttpError).status, route).toBe(404);
      }
      log(`'${FLAG}' is off here: every auto-route route answers 404`);
      return;
    }

    const before = await switchClient.decisionSettings();
    if (before.source === 'workspace') {
      throw new Error(
        'The workspace already has its own decision setting; this scenario ' +
          'would overwrite it. Run it against a server whose workspace uses ' +
          'the server default.'
      );
    }
    expect(before.workspace).toBeNull();
    log(`decision settings start on the server default: ${JSON.stringify(before.server_default)}`);

    try {
      // ── Test with nothing saved ───────────────────────────────────────────
      const tested = await switchClient.testDecisionSettings({ backend: 'default' });
      if (!(before.server_default as { configured: boolean }).configured) {
        expect(tested.ok).toBe(false);
        expect((tested.error as { code: string }).code).toBe('not_configured');
      }
      expect((await switchClient.decisionSettings()).source).toBe('server_default');

      // ── "none" turns auto-route off for the workspace ──────────────────────
      const saved = await switchClient.saveDecisionSettings({ backend: 'none' });
      expect(saved.source).toBe('workspace');
      const effective = saved.effective as { backend: string; available: boolean };
      expect(effective.backend).toBe('none');
      expect(effective.available).toBe(false);

      const agent = await fixtures.agent('dragent');
      const room = await fixtures.internalRoom('drroom', [agent]);
      const off = await switchClient.setRoomAutoRoute(room.id, { on: false });
      expect(off.on).toBe(false);
      expect(off.available).toBe(false);
      const refused = await switchClient.setRoomAutoRoute(room.id, { on: true }).then(
        () => null,
        (error: unknown) => error
      );
      expect(refused).toBeInstanceOf(SwitchHttpError);
      expect((refused as SwitchHttpError).status).toBe(409);
      log("auto-route can't be turned on in a workspace that chose none");
    } finally {
      // ── back to the server default ────────────────────────────────────────
      await switchClient.resetDecisionSettings();
    }
    const after = await switchClient.decisionSettings();
    expect(after.source).toBe('server_default');
    expect(after.workspace).toBeNull();
  },
};
