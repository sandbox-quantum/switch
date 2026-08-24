import { release } from 'node:os';
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

type Attribute = { key: string; value: { stringValue: string } };

function sentRecord(): Record<string, unknown> {
  const resourceLogs = sentBody().resourceLogs as [
    { scopeLogs: [{ logRecords: [Record<string, unknown>] }] },
  ];
  return resourceLogs[0].scopeLogs[0].logRecords[0];
}

function sentResource(): Record<string, string> {
  const resourceLogs = sentBody().resourceLogs as [{ resource: { attributes: Attribute[] } }];
  return Object.fromEntries(
    resourceLogs[0].resource.attributes.map((a) => [a.key, a.value.stringValue])
  );
}

function sentAttributes(): Record<string, string> {
  return Object.fromEntries(
    (sentRecord().attributes as Attribute[]).map((a) => [a.key, a.value.stringValue])
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ partialSuccess: {} }),
  } as unknown as Response);
  // A test run is a dev build, so telemetry is off unless a dev opts in — the
  // same switch a developer uses to watch the traffic locally.
  process.env.SWITCHDASH_TELEMETRY_DEV = '1';
  delete process.env.SWITCHDASH_TELEMETRY_ENDPOINT;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SWITCHDASH_TELEMETRY_DEV;
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

    await telemetryService.track('agent_created', {
      agent_type: 'codex',
      location: 'remote',
      outcome: 'success',
      failure_reason: 'none',
      entry_point: 'sidebar',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://telemetry.flintai.dev/v1/logs');
  });
});

describe('a build that cannot send', () => {
  /**
   * A reason is reported once per process, and the service is a module
   * singleton — so each of these takes a fresh one rather than depending on
   * which test ran first. Sharing it made two of these pass only in
   * declaration order, and fail under a shuffled run.
   */
  async function freshService() {
    vi.resetModules();
    const module = await import('./telemetry-service');
    return module.telemetryService;
  }

  it('makes no request from a dev run that has not opted in, and says so', async () => {
    delete process.env.SWITCHDASH_TELEMETRY_DEV;
    vi.mocked(isTelemetryAllowed).mockResolvedValue(true);
    const service = await freshService();

    await service.track('app_launched', {});

    expect(fetchMock).not.toHaveBeenCalled();
    expect(isTelemetryAllowed).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      'telemetry: not sending',
      expect.objectContaining({ reason: 'dev_build' })
    );
  });

  it('says it once, however many events are dropped', async () => {
    delete process.env.SWITCHDASH_TELEMETRY_DEV;
    const service = await freshService();

    await service.track('app_launched', {});
    await service.track('app_launched', {});
    await service.track('app_launched', {});

    expect(log.info).toHaveBeenCalledTimes(1);
  });
});

describe('asking in advance whether a send would arrive', () => {
  /**
   * The once-per-install events spend a record that is never given back, so they
   * ask before they claim. The answer has to be the same two refusals `track`
   * applies, or the question is worse than not asking.
   */
  it('is no when the build cannot send, without asking the user', async () => {
    delete process.env.SWITCHDASH_TELEMETRY_DEV;
    vi.mocked(isTelemetryAllowed).mockResolvedValue(true);

    expect(await telemetryService.canSend()).toBe(false);
    expect(isTelemetryAllowed).not.toHaveBeenCalled();
  });

  it('is no when the user has not agreed', async () => {
    vi.mocked(isTelemetryAllowed).mockResolvedValue(false);

    expect(await telemetryService.canSend()).toBe(false);
  });

  it('is yes when the build can send and the user has agreed', async () => {
    vi.mocked(isTelemetryAllowed).mockResolvedValue(true);

    expect(await telemetryService.canSend()).toBe(true);
  });

  it('answers without sending anything', async () => {
    vi.mocked(isTelemetryAllowed).mockResolvedValue(true);

    await telemetryService.canSend();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the payload', () => {
  beforeEach(() => {
    vi.mocked(isTelemetryAllowed).mockResolvedValue(true);
  });

  it('identifies the install, and no user', async () => {
    // The relay reads this as Amplitude's device id. It sets a user id only
    // for a caller that sends one, which this is not.
    await telemetryService.track('session_started', {
      agent_type: 'claude',
      location: 'local',
      outcome: 'success',
      failure_reason: 'none',
      entry_point: 'sidebar',
      start_source: 'user',
      has_initial_prompt: false,
      connected_to_room: false,
    });

    expect(sentResource()['flint.client_id']).toBe('install-abc');
    expect(sentResource()).not.toHaveProperty('flint.user_id');
  });

  it('stamps the event when it happened, not after the reads that describe it', async () => {
    // The gate and the install id are both awaited between the two, and on a
    // first send the install id is a write. Taking the time afterwards would
    // date every event by however long its own bookkeeping took.
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(1_000).mockReturnValue(9_000);

    await telemetryService.track('app_launched', {});

    expect(sentRecord().timeUnixNano).toBe('1000000000');
    now.mockRestore();
  });

  it('carries the event, the build and the app version', async () => {
    await telemetryService.track('connector_installed', {
      agent_type: 'claude',
      target: 'remote',
      outcome: 'failure',
    });

    expect(sentResource()['service.version']).toBe('1.2.3');
    expect(sentAttributes()).toEqual({
      'event.name': 'switch_console.connector_installed',
      agent_type: 'claude',
      target: 'remote',
      outcome: 'failure',
      build: 'dev',
    });
  });

  it('names the operating system it is actually running on', async () => {
    const expected = { darwin: 'darwin', win32: 'windows', linux: 'linux' }[
      process.platform as string
    ];

    await telemetryService.track('app_launched', {});

    expect(sentResource()['os.type']).toBe(expected ?? 'other');
    expect(sentResource()['os.version']).toBe(release());
  });

  it('sends nothing beyond the fields this test names', async () => {
    // A substring search for forbidden words would pass whatever the payload
    // contained, since nothing here could produce them. Pinning the whole set
    // of keys is what actually notices a new field arriving.
    await telemetryService.track('session_ended', {
      agent_type: 'codex',
      location: 'remote',
      outcome: 'failed',
    });

    expect(Object.keys(sentResource()).sort()).toEqual([
      'flint.client_id',
      'os.type',
      'os.version',
      'service.name',
      'service.version',
    ]);
    expect(Object.keys(sentAttributes()).sort()).toEqual([
      'agent_type',
      'build',
      'event.name',
      'location',
      'outcome',
    ]);
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
