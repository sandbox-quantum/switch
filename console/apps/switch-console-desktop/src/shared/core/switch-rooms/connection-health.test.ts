import { describe, expect, it } from 'vitest';
import { classifyConnection, connectionNeedsAttention } from './connection-health';

const starting = {
  stopped: false,
  running: true,
  connected: false,
  takenOver: false,
  disconnectedFor: 0,
};
describe('room connection health', () => {
  it('does not call a running process connected without server evidence', () => {
    expect(classifyConnection(starting)).toBe('connecting');
    expect(classifyConnection({ ...starting, disconnectedFor: 15_000 })).toBe('failed');
    expect(classifyConnection({ ...starting, connected: true })).toBe('connected');
  });
  it('keeps deliberate stops and takeover distinct from crashes', () => {
    expect(classifyConnection({ ...starting, stopped: true })).toBe('stopped');
    expect(classifyConnection({ ...starting, takenOver: true })).toBe('taken-over');
    expect(classifyConnection({ ...starting, running: false, disconnectedFor: 15_000 })).toBe(
      'failed'
    );
    expect(connectionNeedsAttention('stopped')).toBe(false);
    expect(connectionNeedsAttention('taken-over')).toBe(true);
  });
  it('allows startup grace even before the watcher process exists', () => {
    expect(classifyConnection({ ...starting, running: false })).toBe('connecting');
    expect(classifyConnection({ ...starting, connected: true })).toBe('connected');
  });
});
