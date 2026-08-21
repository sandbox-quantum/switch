import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The gate between the interface and the catalogue.
 *
 * This is the only place a telemetry value arrives from outside the main
 * process, so it is the only place a type proves nothing. These cover that the
 * check is real: the list of events is closed, and every value is checked
 * against the set the catalogue allows rather than taken on the caller's word.
 */

vi.mock('./telemetry-service', () => ({ trackEvent: vi.fn() }));
vi.mock('@main/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { trackFromRenderer } = await import('./renderer-events');
const { trackEvent } = await import('./telemetry-service');
const { log } = await import('@main/lib/logger');

beforeEach(() => vi.clearAllMocks());

describe('what the interface is allowed to report', () => {
  it('passes a catalogued event with permitted values through to the emitter', () => {
    trackFromRenderer({ name: 'view_opened', properties: { view_id: 'settings' } });

    expect(trackEvent).toHaveBeenCalledWith('view_opened', { view_id: 'settings' });
  });

  it('refuses an event that is not on the list', () => {
    // The renderer may report the handful of moments only it can see. Anything
    // else is a call site and this list disagreeing, which is a bug in the app.
    trackFromRenderer({
      name: 'agent_created' as never,
      properties: { agent_type: 'codex' },
    });

    expect(trackEvent).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it('refuses a value the catalogue does not allow', () => {
    // The whole reason this exists: a type does not survive the crossing, so a
    // screen id that is not one of the app's screens must be caught here.
    trackFromRenderer({ name: 'view_opened', properties: { view_id: 'not-a-view' } });

    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('refuses free text where a closed set is expected', () => {
    trackFromRenderer({
      name: 'command_executed',
      properties: { command_id: '/Users/someone/secret-project', invoked_by: 'palette' },
    });

    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('never writes down the value it rejected', () => {
    // A value that failed this check is exactly the kind of thing that must not
    // reach the log either.
    trackFromRenderer({
      name: 'view_opened',
      properties: { view_id: '/Users/someone/secret-project' },
    });

    expect(JSON.stringify(vi.mocked(log.warn).mock.calls)).not.toContain('secret-project');
  });

  it('drops a property the event does not declare', () => {
    trackFromRenderer({
      name: 'view_opened',
      properties: { view_id: 'home', working_dir: '/Users/someone/secret-project' },
    });

    expect(trackEvent).toHaveBeenCalledWith('view_opened', { view_id: 'home' });
  });

  it('accepts an event that carries nothing of its own', () => {
    trackFromRenderer({ name: 'renderer_crashed', properties: {} });

    expect(trackEvent).toHaveBeenCalledWith('renderer_crashed', {});
  });

  it('refuses a missing property rather than sending the event without it', () => {
    trackFromRenderer({ name: 'command_executed', properties: { invoked_by: 'palette' } });

    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('checks a command id against the commands that exist', () => {
    trackFromRenderer({
      name: 'command_executed',
      properties: { command_id: 'app.settings', invoked_by: 'shortcut' },
    });

    expect(trackEvent).toHaveBeenCalledWith('command_executed', {
      command_id: 'app.settings',
      invoked_by: 'shortcut',
    });
  });
});
