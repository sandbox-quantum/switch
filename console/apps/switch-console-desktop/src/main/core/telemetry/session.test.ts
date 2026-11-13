import { describe, expect, it } from 'vitest';
import { NO_SESSION, SESSION_IDLE_MS, TelemetrySession } from './session';

const MINUTE = 60_000;

describe('a session', () => {
  it('starts with the first thing someone does, and is named for when that was', () => {
    const session = new TelemetrySession();

    expect(session.idFor('view_opened', 1_000, false)).toBe(1_000);
    expect(session.idFor('command_executed', 1_000 + 10 * MINUTE, false)).toBe(1_000);
  });

  it('carries on while each thing comes within half an hour of the last', () => {
    const session = new TelemetrySession();
    const start = 5_000;

    session.idFor('view_opened', start, false);
    session.idFor('view_opened', start + 25 * MINUTE, false);

    expect(session.idFor('view_opened', start + 50 * MINUTE, false)).toBe(start);
  });

  it('ends after half an hour with nothing done, and the next thing starts another', () => {
    const session = new TelemetrySession();
    const later = 2_000 + SESSION_IDLE_MS + 1;

    session.idFor('view_opened', 2_000, false);

    expect(session.idFor('view_opened', later, false)).toBe(later);
  });

  it('puts an event nobody caused in no session, and lets it neither start nor prolong one', () => {
    const session = new TelemetrySession();

    expect(session.idFor('session_discovered', 1_000, false)).toBe(NO_SESSION);
    expect(session.idFor('view_opened', 2_000, false)).toBe(2_000);
    // The app's own work keeps going while nobody is there; it is not use.
    expect(session.idFor('session_reopened', 2_000 + 20 * MINUTE, false)).toBe(NO_SESSION);
    const afterIdle = 2_000 + SESSION_IDLE_MS + 1;
    expect(session.idFor('view_opened', afterIdle, false)).toBe(afterIdle);
  });

  it('puts an occurrence its caller says nobody caused in no session, whatever its name', () => {
    const session = new TelemetrySession();

    expect(session.idFor('session_ended', 1_000, true)).toBe(NO_SESSION);
    expect(session.idFor('view_opened', 2_000, false)).toBe(2_000);
    // A pass pruning an agent while nobody is there does not keep the session
    // going, though a person ending a session would.
    expect(session.idFor('session_ended', 2_000 + 20 * MINUTE, true)).toBe(NO_SESSION);
    const afterIdle = 2_000 + SESSION_IDLE_MS + 1;
    expect(session.idFor('session_ended', afterIdle, false)).toBe(afterIdle);
  });

  it('does not let a report that arrives late cut the session short', () => {
    const session = new TelemetrySession();

    session.idFor('view_opened', 1_000, false);
    session.idFor('view_opened', 1_000 + 25 * MINUTE, false);
    // Reported now, but it happened at the start.
    session.idFor('room_created', 1_000, false);

    expect(session.idFor('view_opened', 1_000 + 50 * MINUTE, false)).toBe(1_000);
  });
});
