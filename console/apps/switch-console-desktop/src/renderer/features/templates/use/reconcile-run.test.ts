import { describe, expect, it } from 'vitest';
import { reconcileRun } from './reconcile-run';

const AGENTS = ['acme-triage-assistant', 'acme-repro-helper'];

describe('a template run read back after Switch Console stopped waiting', () => {
  it('claims nothing either way when the server could not be asked', () => {
    const run = reconcileRun({ agentNames: AGENTS, roomCount: 1, soFar: null });

    expect(run.state).toBe('unknown');
    expect(run.complete).toBe(false);
    expect(run.message).not.toMatch(/Nothing was created/);
    expect(run.message).toMatch(/could not read back/);
  });

  it('shows the agents made and the room still being made while an attempt holds the run', () => {
    const run = reconcileRun({
      agentNames: AGENTS,
      roomCount: 1,
      soFar: {
        inFlight: true,
        agents: [
          { agentId: 'a1', name: 'acme-triage-assistant' },
          { agentId: 'a2', name: 'acme-repro-helper' },
        ],
        rooms: [],
      },
    });

    expect(run.state).toBe('running');
    expect([...run.agents.values()].map((a) => a.status)).toEqual(['created', 'created']);
    expect(run.agents.get('acme-repro-helper')?.agentId).toBe('a2');
    expect(run.room?.status).toBe('creating');
    expect(run.complete).toBe(false);
    expect(run.message).toMatch(/still working/);
  });

  it('marks what is missing as failed once no attempt is going', () => {
    const run = reconcileRun({
      agentNames: AGENTS,
      roomCount: 1,
      soFar: {
        inFlight: false,
        agents: [{ agentId: 'a1', name: 'acme-triage-assistant' }],
        rooms: [],
      },
    });

    expect(run.state).toBe('stopped');
    expect(run.agents.get('acme-triage-assistant')?.status).toBe('created');
    expect(run.agents.get('acme-repro-helper')?.status).toBe('failed');
    expect(run.room?.status).toBe('failed');
    expect(run.message).toMatch(/What was made stays made/);
  });

  it('counts a room made but not yet kicked off as still to finish', () => {
    const run = reconcileRun({
      agentNames: AGENTS,
      roomCount: 1,
      soFar: {
        inFlight: true,
        agents: [
          { agentId: 'a1', name: 'acme-triage-assistant' },
          { agentId: 'a2', name: 'acme-repro-helper' },
        ],
        rooms: [{ roomId: 'r1', roomName: 'Acme Bug Triage', kickoffPosted: false }],
      },
    });

    expect(run.room).toEqual({ status: 'creating', roomId: 'r1', roomName: 'Acme Bug Triage' });
  });

  it('is complete when the server made everything', () => {
    const run = reconcileRun({
      agentNames: AGENTS,
      roomCount: 1,
      soFar: {
        inFlight: false,
        agents: [
          { agentId: 'a1', name: 'acme-triage-assistant' },
          { agentId: 'a2', name: 'acme-repro-helper' },
        ],
        rooms: [{ roomId: 'r1', roomName: 'Acme Bug Triage', kickoffPosted: true }],
      },
    });

    expect(run.complete).toBe(true);
    expect(run.message).toBeNull();
    expect(run.room).toEqual({ status: 'created', roomId: 'r1', roomName: 'Acme Bug Triage' });
  });
});
