import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAmplitudeEvent,
  postAmplitudeEvent,
  TelemetrySendError,
  type TelemetryContext,
} from './amplitude-client';
import type { TelemetryConfig } from './config';

const CONTEXT: TelemetryContext = {
  installId: 'install-abc',
  appVersion: '1.2.3',
  osName: 'macOS',
  osVersion: '24.3.0',
  build: 'stable',
  time: 1_700_000_000_000,
  insertId: 'insert-abc',
};

const CONFIG: TelemetryConfig = {
  apiKey: 'test-key',
  endpoint: 'https://api2.amplitude.com/2/httpapi',
  build: 'stable',
};

describe('the event that gets built', () => {
  it('names the install, and no user', () => {
    const event = buildAmplitudeEvent('app_launched', {}, CONTEXT);

    expect(event.device_id).toBe('install-abc');
    expect(event).not.toHaveProperty('user_id');
  });

  it('carries the catalogued properties, plus which build sent it', () => {
    const event = buildAmplitudeEvent(
      'session_ended',
      { agent_type: 'codex', location: 'remote', outcome: 'failed' },
      CONTEXT
    );

    expect(event.event_properties).toEqual({
      agent_type: 'codex',
      location: 'remote',
      outcome: 'failed',
      build: 'stable',
    });
  });

  it('drops a property the catalogue does not name', () => {
    // Excess-property checking does not apply through a spread, so a field
    // added to some internal shape for an unrelated reason can reach a call
    // site without the compiler objecting. This is where it stops.
    const smuggled = {
      agent_type: 'codex',
      location: 'remote',
      outcome: 'failed',
      working_dir: '/Users/someone/secret-project',
    } as never;

    const event = buildAmplitudeEvent('session_ended', smuggled, CONTEXT);

    expect(event.event_properties).not.toHaveProperty('working_dir');
    expect(JSON.stringify(event)).not.toContain('secret-project');
  });

  it('sends no properties at all for an event that has none', () => {
    const event = buildAmplitudeEvent('app_launched', {}, CONTEXT);

    expect(event.event_properties).toEqual({ build: 'stable' });
  });

  it('declines the location lookup and sends no location of its own', () => {
    const event = buildAmplitudeEvent('app_launched', {}, CONTEXT);

    expect(event.ip).toBe('0.0.0.0');
    for (const field of ['country', 'region', 'city', 'dma', 'location_lat', 'location_lng']) {
      expect(event).not.toHaveProperty(field);
    }
  });

  it('is stamped with when it happened, not when it was built', () => {
    const event = buildAmplitudeEvent('app_launched', {}, CONTEXT);

    expect(event.time).toBe(1_700_000_000_000);
    expect(event.insert_id).toBe('insert-abc');
  });
});

describe('sending it', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200 } as Response);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts one event to the configured endpoint', async () => {
    await postAmplitudeEvent({ event_type: 'app_launched' }, CONFIG);

    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string; method: string }];
    expect(url).toBe(CONFIG.endpoint);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      api_key: 'test-key',
      events: [{ event_type: 'app_launched' }],
    });
  });

  it('names itself rather than letting the runtime volunteer a user agent', async () => {
    // Amplitude parses the user agent into device properties of the event, so
    // an unset one is a field on every event that this code did not choose.
    await postAmplitudeEvent({}, CONFIG);

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers['User-Agent']).toBe('switch-console');
  });

  it('gives up rather than retrying when Amplitude refuses', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 } as Response);

    await expect(postAmplitudeEvent({}, CONFIG)).rejects.toMatchObject({ code: 'http_status' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('tells a network failure apart from a refusal', async () => {
    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

    await expect(postAmplitudeEvent({}, CONFIG)).rejects.toMatchObject({ code: 'network' });
  });

  it('tells a timeout apart from both', async () => {
    // What `AbortSignal.timeout()` rejects with — a slow endpoint must be
    // diagnosable as slow, not filed under "network".
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    fetchMock.mockRejectedValue(timeout);

    await expect(postAmplitudeEvent({}, CONFIG)).rejects.toMatchObject({ code: 'timeout' });
  });

  it('really does time a request out', async () => {
    // Pins the assumption the branch above is written against, against the
    // runtime rather than against a hand-made error.
    const signal = AbortSignal.timeout(1);
    const aborted = new Promise<Error>((resolve) =>
      signal.addEventListener('abort', () => resolve(signal.reason as Error))
    );

    await expect(aborted).resolves.toMatchObject({ name: 'TimeoutError' });
  });

  it('throws something a caller can classify without parsing a message', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400 } as Response);

    await expect(postAmplitudeEvent({}, CONFIG)).rejects.toBeInstanceOf(TelemetrySendError);
  });
});
