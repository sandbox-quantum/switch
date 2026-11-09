/**
 * Visibility L1 in Console, the user's part: Your cloud's figures on the cloud
 * machine card (the designer's wording), and an older server read as no figures.
 */
import { describe, expect, it } from 'vitest';
import {
  boxShowsStopped,
  retainedBoxToWake,
  yourCloudView,
} from '@renderer/features/cloud-agents/your-cloud';
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

  it('steps: plenty below 80%, nearly full from 80% (as the bars), full from 95%', () => {
    const step = (used: number) => {
      const view = yourCloudView(room(used), at);
      return view.resting ? null : [view.heading, view.room?.label];
    };
    expect(step(799)).toEqual(['Ready', 'Plenty of room']);
    expect(step(800)).toEqual(['Nearly full', 'A little left']);
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
      line: 'Your cloud is resting to save resources. It wakes in about a minute when you message an agent or press Wake it.',
      start: 'ensure',
      startLabel: 'Wake',
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

describe('Your cloud shows the box\'s real state, never "Ready" from an old report', () => {
  const GIB2 = 1024 ** 3;
  const up = {
    sleeping: false,
    room: { used_bytes: 1 * GIB2, total_bytes: 8 * GIB2 },
    awake: { running: 0, max: 12 },
    ai_calls_today: null,
    stop_reason: null,
    state: 'ready' as const,
    desired_state: 'running' as const,
    agents: [] as string[],
  };
  const at2 = () => '00:00';

  it('a ready box shows its figures as before', () => {
    const view = yourCloudView(up, at2);
    expect(view.resting).toBe(false);
    expect(view.resting === false && view.heading).toBe('Ready');
  });

  it('a put-away (retained) box reads Stopped, with Start and no figures', () => {
    for (const box of [
      { ...up, state: 'retained' as const, desired_state: 'retained' as const },
      { ...up, state: 'stopped' as const, desired_state: 'retained' as const },
      { ...up, state: 'retained' as const, desired_state: 'retained' as const, sleeping: true },
    ]) {
      expect(yourCloudView(box, at2)).toEqual({
        resting: true,
        heading: 'Stopped',
        line: 'Start it to add or use an agent.',
        start: 'ensure',
      });
    }
  });

  it('a box its owner stopped reads Stopped, with Start by lifecycle (ensure leaves it as it is)', () => {
    expect(
      yourCloudView(
        { ...up, state: 'stopped', desired_state: 'stopped', stop_reason: 'owner' },
        at2
      )
    ).toEqual({
      resting: true,
      heading: 'Stopped',
      line: 'Start it to use your agents.',
      start: 'lifecycle',
    });
  });

  it('a box on its way up reads Starting…, with no Start and no figures', () => {
    for (const state of ['queued', 'provisioning'] as const) {
      expect(yourCloudView({ ...up, state }, at2)).toEqual({
        resting: true,
        heading: 'Starting…',
        line: 'Usually ready in about two minutes.',
      });
    }
    expect(yourCloudView({ ...up, state: 'stopped', desired_state: 'running' }, at2)).toEqual({
      resting: true,
      heading: 'Starting…',
      line: 'Usually ready in about two minutes.',
    });
  });

  it('a stopping box reads Stopping…, with no Start', () => {
    expect(yourCloudView({ ...up, state: 'stopping', desired_state: 'stopped' }, at2)).toEqual({
      resting: true,
      heading: 'Stopping…',
      line: 'Start it again once it has stopped.',
    });
  });

  it('a resting box with agents wakes by a message or Wake; with none, it offers Start', () => {
    const resting = {
      ...up,
      state: 'stopped' as const,
      desired_state: 'stopped' as const,
      sleeping: true,
    };
    expect(yourCloudView({ ...resting, agents: ['a1'] }, at2)).toEqual({
      resting: true,
      heading: 'Resting',
      line: 'Your cloud is resting to save resources. It wakes in about a minute when you message an agent or press Wake it.',
      start: 'ensure',
      startLabel: 'Wake',
    });
    expect(yourCloudView(resting, at2)).toEqual({
      resting: true,
      heading: 'Resting',
      line: 'Start it to add an agent.',
      start: 'ensure',
    });
  });

  it('a paused or turned-off box never offers Start, even when retained', () => {
    for (const stop_reason of ['paused', 'turned_off'] as const) {
      const view = yourCloudView(
        { ...up, state: 'retained', desired_state: 'retained', stop_reason },
        at2
      );
      expect(view.resting && 'start' in view).toBe(false);
    }
  });

  it('any other state that is not up reads Stopped, with no figures and no Start', () => {
    for (const state of ['error', 'deleting', 'deleted'] as const) {
      expect(yourCloudView({ ...up, state }, at2)).toEqual({
        resting: true,
        heading: 'Stopped',
        line: 'Not running right now.',
      });
    }
  });
  it('tells the agents to read Stopped only when Your cloud says Stopped', () => {
    const box = { ...up, agents: ['a1'] };
    expect(boxShowsStopped({ ...box, state: 'retained' as const })).toBe(true);
    expect(
      boxShowsStopped({ ...box, state: 'stopped' as const, desired_state: 'stopped' as const })
    ).toBe(true);
    expect(boxShowsStopped(box)).toBe(false);
    expect(boxShowsStopped({ ...box, state: 'stopped' as const, sleeping: true })).toBe(false);
    expect(
      boxShowsStopped({ ...box, state: 'stopped' as const, stop_reason: 'paused' as const })
    ).toBe(false);
  });
});

describe('Signing in wakes a put-away box, and never makes one', () => {
  const box = {
    backend: 'box' as const,
    state: 'retained' as const,
    desired_state: 'retained' as const,
    stop_reason: 'idle' as const,
  };

  it('wakes a retained box', () => {
    expect(retainedBoxToWake([box])).toBe(true);
    expect(retainedBoxToWake([{ ...box, state: 'stopped' }])).toBe(true);
  });

  it('leaves a box that is up, resting or starting alone', () => {
    expect(retainedBoxToWake([{ ...box, state: 'ready', desired_state: 'running' }])).toBe(false);
    expect(retainedBoxToWake([{ ...box, state: 'stopped', desired_state: 'stopped' }])).toBe(false);
    expect(
      retainedBoxToWake([
        { ...box, state: 'stopped', desired_state: 'stopped', stop_reason: 'owner' },
      ])
    ).toBe(false);
    expect(retainedBoxToWake([{ ...box, state: 'provisioning', desired_state: 'running' }])).toBe(
      false
    );
  });

  it('never makes a box: no machine, or a server with none, wakes nothing', () => {
    expect(retainedBoxToWake([])).toBe(false);
    expect(retainedBoxToWake(null)).toBe(false);
  });

  it('leaves a v1 machine and a paused or turned-off box alone', () => {
    expect(retainedBoxToWake([{ ...box, backend: 'vm' }])).toBe(false);
    expect(retainedBoxToWake([{ ...box, backend: undefined }])).toBe(false);
    expect(retainedBoxToWake([{ ...box, stop_reason: 'paused' }])).toBe(false);
    expect(retainedBoxToWake([{ ...box, stop_reason: 'turned_off' }])).toBe(false);
  });
});
