import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelemetryConfig } from './config';
import {
  buildOtlpPayload,
  postTelemetryEvent,
  TelemetrySendError,
  type TelemetryContext,
} from './relay-client';

const CONTEXT: TelemetryContext = {
  clientId: '11111111-2222-4333-8444-555555555555',
  appVersion: '1.2.3',
  osType: 'darwin',
  osVersion: '24.3.0',
  build: 'stable',
  timeMs: 1_700_000_000_000,
};

const CONFIG: TelemetryConfig = {
  endpoint: 'https://telemetry.example/v1/logs',
  build: 'stable',
};

type Attribute = { key: string; value: { stringValue: string } };

function resourceAttributes(payload: Record<string, unknown>): Record<string, string> {
  const resourceLogs = payload.resourceLogs as [{ resource: { attributes: Attribute[] } }];
  return Object.fromEntries(
    resourceLogs[0].resource.attributes.map((a) => [a.key, a.value.stringValue])
  );
}

function logRecord(payload: Record<string, unknown>): Record<string, unknown> {
  const resourceLogs = payload.resourceLogs as [
    { scopeLogs: [{ logRecords: [Record<string, unknown>] }] },
  ];
  return resourceLogs[0].scopeLogs[0].logRecords[0];
}

function logAttributes(payload: Record<string, unknown>): Record<string, string> {
  const attributes = logRecord(payload).attributes as Attribute[];
  return Object.fromEntries(attributes.map((a) => [a.key, a.value.stringValue]));
}

describe('the record that gets built', () => {
  it('carries the client id the relay requires, as a resource attribute', () => {
    // Without it the relay drops the whole payload — and still answers 200.
    const payload = buildOtlpPayload('app_launched', {}, CONTEXT);

    expect(resourceAttributes(payload)['flint.client_id']).toBe(CONTEXT.clientId);
  });

  it('says which app and version it is, for both destinations', () => {
    const payload = buildOtlpPayload('app_launched', {}, CONTEXT);

    expect(resourceAttributes(payload)).toEqual({
      'service.name': 'switch-console',
      'service.version': '1.2.3',
      'flint.client_id': CONTEXT.clientId,
      'os.type': 'darwin',
      'os.version': '24.3.0',
    });
  });

  it('names the event under this product, since one project holds them all', () => {
    const payload = buildOtlpPayload(
      'session_started',
      { agent_type: 'codex', location: 'local' },
      CONTEXT
    );

    expect(logAttributes(payload)['event.name']).toBe('switch_console.session_started');
  });

  it('names it in the record field too, which is what the relay reads first', () => {
    // The attribute alone gets a record past the relay's "is it named?" filter
    // and then dropped by an exporter that only reads the field — silently, and
    // with a 200 at every step. Both, or nothing arrives and nothing says so.
    const payload = buildOtlpPayload('app_launched', {}, CONTEXT);

    expect(logRecord(payload).eventName).toBe('switch_console.app_launched');
  });

  it('carries the catalogued properties, plus which build sent it', () => {
    const payload = buildOtlpPayload(
      'session_ended',
      { agent_type: 'codex', location: 'remote', outcome: 'failed' },
      CONTEXT
    );

    expect(logAttributes(payload)).toEqual({
      'event.name': 'switch_console.session_ended',
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

    const payload = buildOtlpPayload('session_ended', smuggled, CONTEXT);

    expect(logAttributes(payload)).not.toHaveProperty('working_dir');
    expect(JSON.stringify(payload)).not.toContain('secret-project');
  });

  it('sends an event with no properties of its own as just its name and build', () => {
    const payload = buildOtlpPayload('app_launched', {}, CONTEXT);

    expect(logAttributes(payload)).toEqual({
      'event.name': 'switch_console.app_launched',
      build: 'stable',
    });
  });

  it('carries a body, so the event is not a blank line in the log sink', () => {
    // The relay forwards the same record to Datadog, which reads the body as
    // the message. It repeats the name rather than adding anything new.
    const payload = buildOtlpPayload('app_launched', {}, CONTEXT);

    expect(logRecord(payload).body).toEqual({ stringValue: 'switch_console.app_launched' });
  });

  it('refuses to invent a property the catalogue promised', () => {
    // Coercing a missing value would put the string "undefined" into the data
    // as though it were an answer. Better to lose the event and say so.
    const incomplete = { agent_type: 'codex' } as never;

    expect(() => buildOtlpPayload('session_ended', incomplete, CONTEXT)).toThrow(
      /missing the catalogued property/
    );
  });

  it('stamps the time in nanoseconds, which is what OTLP counts in', () => {
    const payload = buildOtlpPayload('app_launched', {}, CONTEXT);

    const record = logRecord(payload);
    expect(record.timeUnixNano).toBe('1700000000000000000');
    expect(record.observedTimeUnixNano).toBe('1700000000000000000');
  });

  it('stays far under the attribute count the relay drops a record for', () => {
    // The guard drops any record with more than 128 attributes.
    const payload = buildOtlpPayload(
      'connector_installed',
      { agent_type: 'claude', target: 'remote', outcome: 'success' },
      CONTEXT
    );

    expect(Object.keys(logAttributes(payload)).length).toBeLessThan(16);
  });
});

describe('sending it', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    // What the relay actually answers: a 200 whose body reports nothing
    // rejected. A double without `json` would not be a Response.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ partialSuccess: {} }),
    } as unknown as Response);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts OTLP JSON to the configured endpoint', async () => {
    await postTelemetryEvent({ resourceLogs: [] }, CONFIG);

    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { body: string; method: string; headers: Record<string, string> },
    ];
    expect(url).toBe(CONFIG.endpoint);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ resourceLogs: [] });
  });

  it('carries no credential, because the relay holds them instead', async () => {
    await postTelemetryEvent({ resourceLogs: [] }, CONFIG);

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(Object.keys(init.headers).sort()).toEqual(['Content-Type', 'User-Agent']);
    expect(init.headers['User-Agent']).toBe('switch-console');
  });

  it('reports records the relay says it would not take', async () => {
    // A 200 is the answer to a dropped payload as well as an accepted one, so
    // the only rejection this end can ever see is the one it is told about.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        partialSuccess: { rejectedLogRecords: '1', errorMessage: 'nope' },
      }),
    } as unknown as Response);

    await expect(postTelemetryEvent({}, CONFIG)).rejects.toMatchObject({ code: 'rejected' });
  });

  it('treats the ordinary empty partial success as success', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ partialSuccess: {} }),
    } as unknown as Response);

    await expect(postTelemetryEvent({}, CONFIG)).resolves.toBeUndefined();
  });

  it('does not fail an accepted send over a body it cannot parse', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response);

    await expect(postTelemetryEvent({}, CONFIG)).resolves.toBeUndefined();
  });

  it('gives up rather than retrying when the relay refuses', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 } as Response);

    await expect(postTelemetryEvent({}, CONFIG)).rejects.toMatchObject({ code: 'http_status' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('tells a network failure apart from a refusal', async () => {
    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

    await expect(postTelemetryEvent({}, CONFIG)).rejects.toMatchObject({ code: 'network' });
  });

  it('tells a timeout apart from both', async () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    fetchMock.mockRejectedValue(timeout);

    await expect(postTelemetryEvent({}, CONFIG)).rejects.toMatchObject({ code: 'timeout' });
  });

  it('is written against what this runtime actually names a timeout', async () => {
    // The test above hands the branch an error it made up. This one checks the
    // name it made up is the one Node really produces — otherwise both agree
    // with each other and neither agrees with production.
    const signal = AbortSignal.timeout(1);
    const aborted = new Promise<Error>((resolve) =>
      signal.addEventListener('abort', () => resolve(signal.reason as Error))
    );

    await expect(aborted).resolves.toMatchObject({ name: 'TimeoutError' });
  });

  it('throws something a caller can classify without parsing a message', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400 } as Response);

    await expect(postTelemetryEvent({}, CONFIG)).rejects.toBeInstanceOf(TelemetrySendError);
  });
});
