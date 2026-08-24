import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The gate between the interface and the catalogue.
 *
 * This is the only place a telemetry value arrives from outside the main
 * process, so it is the only place a type proves nothing. These cover that the
 * check is real: the list of events is closed, and every value is checked
 * against the set the catalogue allows rather than taken on the caller's word.
 */

const { store, canSend, UNREADABLE, UNWRITABLE } = vi.hoisted(() => ({
  store: new Map<string, boolean>(),
  canSend: vi.fn(async () => true),
  /**
   * Set this key and reads of the record fail. Reading it is a database read in
   * the real thing, and a database read can fail — the only way into the branch
   * that decides what to do when the record cannot be read.
   */
  UNREADABLE: '__unreadable__',
  /**
   * The same for writes. The claim is written with `setOrThrow` rather than
   * `set`, precisely so a failed write is not silently treated as a claim, so
   * this branch is reachable too.
   */
  UNWRITABLE: '__unwritable__',
}));

vi.mock('./telemetry-service', () => ({
  trackEvent: vi.fn(),
  telemetryService: { canSend },
}));
// The once-per-install record. Backed by the database in the real thing, which
// this project has no Electron app to open.
vi.mock('@main/db/kv', () => ({
  KV: class {
    get(key: string) {
      if (store.get(UNREADABLE) === true) return Promise.reject(new Error('kv: read failed'));
      return Promise.resolve(store.get(key) ?? null);
    }
    set(key: string, value: boolean) {
      store.set(key, value);
      return Promise.resolve();
    }
    setOrThrow(key: string, value: boolean) {
      if (store.get(UNWRITABLE) === true) return Promise.reject(new Error('kv: write failed'));
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
  canSend.mockResolvedValue(true);
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

  it('does not ask the gate in advance for an ordinary event', async () => {
    // Only an event that spends a record has anything to lose by being refused.
    // Everywhere else, asking first and sending second reads a gate that can
    // change in between, and the emitter already reads it at the one moment that
    // matters.
    trackFromRenderer({ name: 'view_opened', properties: { view_id: 'home' } });
    await settle();

    expect(canSend).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledTimes(1);
  });
});

/**
 * Finishing onboarding is a condition, not a moment — true from the instant it
 * becomes true and true again on every launch. Each test takes a fresh copy of
 * the module, because "already reported in this run" is deliberately process
 * state: one run of the app is one chance to report.
 *
 * The record is never given back, so as much of what follows is about when it is
 * *not* spent as about when it is.
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
    canSend.mockResolvedValue(true);
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
    // A duplicate is the failure this exists to prevent, so a record we cannot
    // read is treated as one that might already say yes.
    store.set(UNREADABLE, true);
    const gate = await freshGate();

    gate({ name: 'onboarding_completed', properties: {} });
    await settle();
    gate({ name: 'onboarding_completed', properties: {} });
    await settle();

    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('has not spent the record on a read that failed', async () => {
    store.set(UNREADABLE, true);
    const failed = await freshGate();
    failed({ name: 'onboarding_completed', properties: {} });
    await settle();
    expect(trackEvent).not.toHaveBeenCalled();

    // Nothing was written, so the next run of the app is a fresh chance rather
    // than a run that inherits a record nobody managed to make.
    store.delete(UNREADABLE);
    const later = await freshGate();
    later({ name: 'onboarding_completed', properties: {} });
    await settle();

    expect(trackEvent).toHaveBeenCalledTimes(1);
  });

  it('stays quiet rather than reporting without a record it could keep', async () => {
    // A write that failed leaves nothing to stop the next run reporting again,
    // so sending anyway buys one report at the price of a duplicate. The same
    // trade as the unreadable record above, made the same way.
    store.set(UNWRITABLE, true);
    const gate = await freshGate();

    gate({ name: 'onboarding_completed', properties: {} });
    await settle();

    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('claims nothing while a send would be refused, so it can still be reported', async () => {
    // The app renders behind the first-run consent prompt, so an install that
    // already has a server, an agent and a room reports a finished checklist
    // while the answer is still unset. Spending the record there would retire the
    // event for the life of the install.
    canSend.mockResolvedValue(false);
    const gate = await freshGate();

    gate({ name: 'onboarding_completed', properties: {} });
    await settle();

    expect(trackEvent).not.toHaveBeenCalled();
    expect(store.size).toBe(0);

    canSend.mockResolvedValue(true);
    gate({ name: 'onboarding_completed', properties: {} });
    await settle();

    expect(trackEvent).toHaveBeenCalledTimes(1);
  });
});
