import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@main/lib/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@main/core/app/utils', () => ({ resolveAppVersion: vi.fn(async () => '1.2.3') }));
vi.mock('./consent', () => ({ isTelemetryAllowed: vi.fn() }));
vi.mock('./install-id', () => ({ getInstallId: vi.fn(async () => 'install-abc') }));

import { log } from '@main/lib/logger';
import { isTelemetryAllowed } from './consent';
import { telemetryService, trackEvent } from './telemetry-service';

const fetchMock = vi.fn();

function sentBody(): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
  return JSON.parse(init.body) as Record<string, unknown>;
}

function sentEvent(): Record<string, unknown> {
  return (sentBody().events as Record<string, unknown>[])[0];
}

/** Anything a payload must never carry, as it would appear once serialised. */
function payloadText(): string {
  return JSON.stringify(sentBody());
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue({ ok: true, status: 200 } as Response);
  // A test run is a dev build, so telemetry is off unless a dev opts in — the
  // same switch a developer uses to watch the traffic locally.
  process.env.SWITCHDASH_TELEMETRY_DEV = '1';
  process.env.MAIN_VITE_AMPLITUDE_API_KEY = 'test-key';
  delete process.env.SWITCHDASH_TELEMETRY_ENDPOINT;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SWITCHDASH_TELEMETRY_DEV;
  delete process.env.MAIN_VITE_AMPLITUDE_API_KEY;
});

describe('the consent gate', () => {
  it('makes no request at all when consent is off', async () => {
    vi.mocked(isTelemetryAllowed).mockResolvedValue(false);

    await telemetryService.track('app_launched', {});

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks the gate again for every event, so revoking consent stops the next one', async () => {
    vi.mocked(isTelemetryAllowed).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await telemetryService.track('app_launched', {});
    await telemetryService.track('app_launched', {});

    expect(isTelemetryAllowed).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends once consent is given', async () => {
    vi.mocked(isTelemetryAllowed).mockResolvedValue(true);

    await telemetryService.track('agent_created', { agent_type: 'codex', location: 'remote' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://api2.amplitude.com/2/httpapi');
  });
});

// Each reason is reported once per process, so these two assert the first
// occurrence of theirs and must not be split into more cases of the same reason.
describe('a build that cannot send', () => {
  it('makes no request when there is no API key, and says so', async () => {
    delete process.env.MAIN_VITE_AMPLITUDE_API_KEY;
    vi.mocked(isTelemetryAllowed).mockResolvedValue(true);

    await telemetryService.track('app_launched', {});

    expect(fetchMock).not.toHaveBeenCalled();
    expect(isTelemetryAllowed).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'telemetry: not sending',
      expect.objectContaining({ reason: 'no_api_key' })
    );
  });

  it('makes no request from a dev run that has not opted in', async () => {
    delete process.env.SWITCHDASH_TELEMETRY_DEV;
    vi.mocked(isTelemetryAllowed).mockResolvedValue(true);

    await telemetryService.track('app_launched', {});

    expect(fetchMock).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      'telemetry: not sending',
      expect.objectContaining({ reason: 'dev_build' })
    );
  });
});

describe('the payload', () => {
  beforeEach(() => {
    vi.mocked(isTelemetryAllowed).mockResolvedValue(true);
  });

  it('identifies the install and nothing else', async () => {
    await telemetryService.track('session_started', { agent_type: 'claude', location: 'local' });

    const event = sentEvent();
    expect(event.device_id).toBe('install-abc');
    expect(event).not.toHaveProperty('user_id');
  });

  it("declines Amplitude's location lookup and sends no location fields", async () => {
    await telemetryService.track('app_launched', {});

    const event = sentEvent();
    expect(event.ip).toBe('0.0.0.0');
    for (const field of ['country', 'region', 'city', 'dma', 'location_lat', 'location_lng']) {
      expect(event).not.toHaveProperty(field);
    }
  });

  it('carries the event, the build, the app version and the OS', async () => {
    await telemetryService.track('connector_installed', {
      agent_type: 'claude',
      target: 'remote',
      outcome: 'failure',
    });

    const event = sentEvent();
    expect(event.event_type).toBe('connector_installed');
    expect(event.app_version).toBe('1.2.3');
    expect(event.os_name).toEqual(expect.any(String));
    expect(event.event_properties).toEqual({
      agent_type: 'claude',
      target: 'remote',
      outcome: 'failure',
      build: 'dev',
    });
  });

  it('carries no machine, user or network identity', async () => {
    await telemetryService.track('session_ended', {
      agent_type: 'codex',
      location: 'remote',
      outcome: 'failed',
    });

    const text = payloadText().toLowerCase();
    for (const forbidden of ['hostname', 'username', 'home/', 'users/', '@', 'mac_address']) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe('failure', () => {
  beforeEach(() => {
    vi.mocked(isTelemetryAllowed).mockResolvedValue(true);
  });

  it('never reaches the caller, and is logged with a code', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 } as Response);

    expect(() => trackEvent('app_launched', {})).not.toThrow();
    await vi.waitFor(() =>
      expect(log.warn).toHaveBeenCalledWith(
        'telemetry: event not sent',
        expect.objectContaining({ errorCode: 'http_status' })
      )
    );
  });

  it('reports a network failure as such rather than as a send', async () => {
    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

    trackEvent('app_launched', {});

    await vi.waitFor(() =>
      expect(log.warn).toHaveBeenCalledWith(
        'telemetry: event not sent',
        expect.objectContaining({ errorCode: 'network' })
      )
    );
  });

  it('does not retry', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as Response);

    await telemetryService.track('app_launched', {}).catch(() => {});

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
