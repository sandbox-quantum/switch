import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The gate between the interface and the catalogue.
 *
 * This is the only place a telemetry value arrives from outside the main
 * process, so it is the only place a type proves nothing. These cover that the
 * check is real: the list of events is closed, and every value is checked
 * against the set the catalogue allows rather than taken on the caller's word.
 */

const { store } = vi.hoisted(() => ({ store: new Map<string, boolean>() }));

vi.mock('./telemetry-service', () => ({ trackEvent: vi.fn() }));
// The once-per-install record. Backed by the database in the real thing, which
// this project has no Electron app to open.
vi.mock('@main/db/kv', () => ({
  KV: class {
    get(key: string) {
      return Promise.resolve(store.get(key) ?? null);
    }
    set(key: string, value: boolean) {
      store.set(key, value);
      return Promise.resolve();
    }
  },
}));
vi.mock('@main/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { trackFromRenderer } = await import('./renderer-events');
const { trackEvent } = await import('./telemetry-service');
const { log } = await import('@main/lib/logger');

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
});

/** The once-only path settles on a promise, so let it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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

  it('still reports an ordinary event every time it happens', async () => {
    trackFromRenderer({ name: 'view_opened', properties: { view_id: 'home' } });
    trackFromRenderer({ name: 'view_opened', properties: { view_id: 'settings' } });
    await settle();

    expect(trackEvent).toHaveBeenCalledTimes(2);
  });
});

/**
 * Finishing onboarding is a condition, not a moment — true from the instant it
 * becomes true and true again on every launch. Each test takes a fresh copy of
 * the module, because "already reported in this run" is deliberately process
 * state: one run of the app is one chance to report.
 */
describe('an event reported once per install', () => {
  async function freshGate() {
    vi.resetModules();
    const mod = await import('./renderer-events');
    return mod.trackFromRenderer;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
  });

  it('reports once however many times the interface asks', async () => {
    const gate = await freshGate();

    gate({ name: 'onboarding_completed', properties: {} });
    gate({ name: 'onboarding_completed', properties: {} });
    gate({ name: 'onboarding_completed', properties: {} });
    await settle();

    expect(trackEvent).toHaveBeenCalledTimes(1);
  });

  it('writes down that it reported, so a later run stays quiet', async () => {
    const first = await freshGate();
    first({ name: 'onboarding_completed', properties: {} });
    await settle();
    expect(trackEvent).toHaveBeenCalledTimes(1);
    vi.mocked(trackEvent).mockClear();

    // A new run of the app: fresh process state, same stored record.
    const later = await freshGate();
    later({ name: 'onboarding_completed', properties: {} });
    await settle();

    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('stays quiet rather than reporting twice when the record cannot be read', async () => {
    // A duplicate is the failure this exists to prevent, so an unreadable record
    // is not a reason to send a second one.
    store.set('__throw__', true);
    const gate = await freshGate();

    gate({ name: 'onboarding_completed', properties: {} });
    await settle();
    vi.mocked(trackEvent).mockClear();

    gate({ name: 'onboarding_completed', properties: {} });
    await settle();

    expect(trackEvent).not.toHaveBeenCalled();
  });
});
