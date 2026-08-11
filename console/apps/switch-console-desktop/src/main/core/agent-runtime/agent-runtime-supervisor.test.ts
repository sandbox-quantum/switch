import { describe, expect, it, vi } from 'vitest';
import type { Pty } from '@main/core/pty/pty';
import {
  AGENT_FRESH_RECOVERY_GRACE_MS,
  MAX_AGENT_RESUME_ATTEMPTS,
  AgentRuntimeSupervisor,
} from './agent-runtime-supervisor';

function fakePty(): Pty {
  return {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
  };
}

describe('AgentRuntimeSupervisor', () => {
  it('rejects and kills a spawn that returns after explicit stop invalidated its token', () => {
    const supervisor = new AgentRuntimeSupervisor();
    const token = supervisor.beginStart();
    expect(token).toBeDefined();

    supervisor.stop();

    const pty = fakePty();
    expect(supervisor.acceptSpawn(token!, pty)).toBe(false);
  });

  it('falls back to a fresh replacement after one resume exit', () => {
    const supervisor = new AgentRuntimeSupervisor();
    const initial = fakePty();
    const initialToken = supervisor.beginStart({ mode: 'fresh' });
    expect(supervisor.acceptSpawn(initialToken!, initial)).toBe(true);

    expect(supervisor.handleExit(initial)).toEqual({ kind: 'respawnResume' });

    for (let attempt = 1; attempt <= MAX_AGENT_RESUME_ATTEMPTS; attempt += 1) {
      const pty = fakePty();
      const token = supervisor.beginStart({
        requireDesired: true,
        mode: 'resume',
      });
      expect(supervisor.acceptSpawn(token!, pty)).toBe(true);

      const decision = supervisor.handleExit(pty);
      if (attempt < MAX_AGENT_RESUME_ATTEMPTS) {
        expect(decision).toEqual({ kind: 'respawnResume' });
      } else {
        expect(decision).toEqual({ kind: 'respawnFresh' });
      }
    }
  });

  it('fails when a fresh recovery exits before the startup grace period', () => {
    const supervisor = new AgentRuntimeSupervisor();
    const first = fakePty();
    const firstToken = supervisor.beginStart({ mode: 'resume' });
    expect(supervisor.acceptSpawn(firstToken!, first)).toBe(true);

    expect(supervisor.handleExit(first)).toEqual({ kind: 'respawnFresh' });

    const fresh = fakePty();
    const freshToken = supervisor.beginStart({
      requireDesired: true,
      mode: 'fresh',
    });
    expect(supervisor.acceptSpawn(freshToken!, fresh)).toBe(true);
    expect(supervisor.handleExit(fresh)).toEqual({ kind: 'failed' });
    expect(supervisor.isDesired()).toBe(false);
  });

  it('resets recovery after a fresh replacement survives the startup grace period', () => {
    vi.useFakeTimers();
    try {
      const supervisor = new AgentRuntimeSupervisor();
      const first = fakePty();
      const firstToken = supervisor.beginStart({ mode: 'resume' });
      expect(supervisor.acceptSpawn(firstToken!, first)).toBe(true);

      expect(supervisor.handleExit(first)).toEqual({ kind: 'respawnFresh' });

      const fresh = fakePty();
      const freshToken = supervisor.beginStart({
        requireDesired: true,
        mode: 'fresh',
      });
      expect(supervisor.acceptSpawn(freshToken!, fresh)).toBe(true);

      vi.advanceTimersByTime(AGENT_FRESH_RECOVERY_GRACE_MS);
      expect(supervisor.handleExit(fresh)).toEqual({ kind: 'respawnResume' });

      const retry = fakePty();
      const retryToken = supervisor.beginStart({
        requireDesired: true,
        mode: 'resume',
      });
      expect(supervisor.acceptSpawn(retryToken!, retry)).toBe(true);
      expect(supervisor.handleExit(retry)).toEqual({ kind: 'respawnFresh' });
    } finally {
      vi.useRealTimers();
    }
  });
});
