/**
 * Visibility L1 in Console, the user's part: Your cloud's figures on the cloud
 * machine card (the designer's wording), and an older server read as no figures.
 */
import { describe, expect, it } from 'vitest';
import { yourCloudView } from '@renderer/features/cloud-agents/your-cloud';
import { cloudMachineSchema } from '@shared/core/cloud-agents/cloud-agents';

const GIB = 1024 ** 3;
const at = (date: Date) => `${String(date.getUTCHours()).padStart(2, '0')}:00 UTC`;

describe('Your cloud on the cloud machine card', () => {
  const machine = {
    sleeping: false,
    room: { used_bytes: 6 * GIB, total_bytes: 8 * GIB },
    awake: { running: 3, max: 15 },
    ai_calls_today: {
      used: 40,
      cap: 200,
      capped: false,
      resets_at: '2026-10-30T00:00:00Z',
    },
  };
  const room = (used: number) => ({ ...machine, room: { used_bytes: used, total_bytes: 1000 } });

  it('shows the room step, sessions awake and AI calls today (designer)', () => {
    const view = yourCloudView(machine, at);
    expect(view).toEqual({
      resting: false,
      heading: 'Ready',
      room: { usedPercent: 75, step: 'plenty', label: 'Plenty of room' },
      awake: { label: '3 of 15 awake' },
      aiCalls: { label: '40 of 200 AI calls today, resets at 00:00 UTC', capped: false },
    });
  });

  it('steps: plenty to 80%, a little left above it, full from 95%', () => {
    const step = (used: number) => {
      const view = yourCloudView(room(used), at);
      return view.resting ? null : [view.heading, view.room?.label];
    };
    expect(step(800)).toEqual(['Ready', 'Plenty of room']);
    expect(step(801)).toEqual(['Nearly full', 'A little left']);
    expect(step(949)).toEqual(['Nearly full', 'A little left']);
    expect(step(950)).toEqual(['Full right now', 'Full right now']);
  });

  it('a paused or turned-off cloud says so, with no figures, pause first (copy)', () => {
    expect(yourCloudView({ ...machine, stop_reason: 'paused' }, at)).toEqual({
      resting: true,
      heading: 'Paused by Switch',
      line: 'Contact your admin',
    });
    expect(yourCloudView({ ...machine, sleeping: true, stop_reason: 'turned_off' }, at)).toEqual({
      resting: true,
      heading: 'Turned off by your admin',
      line: 'Ask your admin to turn it on',
    });
    expect(yourCloudView({ ...machine, stop_reason: 'idle' }, at).resting).toBe(false);
  });

  it('a resting cloud shows no figures, only how it wakes', () => {
    expect(yourCloudView({ ...machine, sleeping: true }, at)).toEqual({
      resting: true,
      heading: 'Resting',
      line: 'Starts when you message an agent.',
    });
  });

  it('hides the AI calls with no cap, and says when the limit is reached', () => {
    const noCap = yourCloudView({ ...machine, ai_calls_today: null }, at);
    expect(noCap.resting === false && noCap.aiCalls).toBeNull();
    const capped = yourCloudView(
      { ...machine, ai_calls_today: { ...machine.ai_calls_today, used: 200, capped: true } },
      at
    );
    expect(capped.resting === false && capped.aiCalls).toEqual({
      label: "Today's AI limit is reached (200). It resets at 00:00 UTC.",
      capped: true,
    });
  });

  it('reads an older server without the figures, and V3 stop reasons', () => {
    const base = {
      machine_id: 'm1',
      state: 'stopped',
      desired_state: 'stopped',
      stop_reason: 'paused',
      sleeping: false,
      revision: 1,
      instance_type: null,
      error: null,
      error_code: null,
      retain_until: null,
      heartbeat_at: null,
      disk: null,
      memory: null,
      agents: [],
      controller_id: null,
    };
    const parsed = cloudMachineSchema.parse(base);
    expect([parsed.room, parsed.awake, parsed.ai_calls_today]).toEqual([null, null, null]);
    expect(cloudMachineSchema.parse({ ...base, stop_reason: 'turned_off' }).stop_reason).toBe(
      'turned_off'
    );
  });
});
