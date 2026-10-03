import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AccessTokens,
  ControllerApiError,
  ControllerClient,
  enroll,
  normalizeServerUrl,
  PROTOCOL_HEADER,
} from './api';
import { ConfigurationError } from './errors';
import { silentLogger } from './log';
import {
  type Assignment,
  controllerBeatRequestSchema,
  controllerConnectionRequestSchema,
} from './schemas';
import { FakeCore } from './testing/fake-core';

let core: FakeCore;
let clock: number;

beforeEach(async () => {
  core = new FakeCore();
  await core.start();
  clock = Date.now();
});

afterEach(async () => {
  await core.stop();
});

function client(credential = core.credential) {
  const tokens = new AccessTokens({
    fetch,
    server: core.url,
    controllerId: core.controllerId,
    credential: async () => credential,
    now: () => clock,
    log: silentLogger,
  });
  return {
    tokens,
    client: new ControllerClient({
      fetch,
      server: core.url,
      controllerId: core.controllerId,
      version: '0.1.0',
      tokens,
    }),
  };
}

const assignment: Assignment = {
  revision: 2,
  agents: [
    {
      agent_id: 'agent-1',
      revision: 1,
      desired_state: 'running',
      definition: {
        name: 'scout',
        display_name: null,
        icon_url: null,
        provider: 'claude',
        model: null,
        instructions: '',
        auto_session: true,
        auto_approve: false,
        directory: null,
      },
    },
  ],
};

describe('normalizeServerUrl', () => {
  it('accepts https and loopback http, without a trailing slash', () => {
    expect(normalizeServerUrl('https://switch.example.com/')).toBe('https://switch.example.com');
    expect(normalizeServerUrl('https://switch.example.com/bridge/')).toBe(
      'https://switch.example.com/bridge'
    );
    expect(normalizeServerUrl('http://127.0.0.1:8000')).toBe('http://127.0.0.1:8000');
    expect(normalizeServerUrl('http://localhost:8000')).toBe('http://localhost:8000');
  });

  it('refuses plain http to another host, credentials in the URL, and non-URLs', () => {
    expect(() => normalizeServerUrl('http://switch.example.com')).toThrow(/https/);
    expect(() => normalizeServerUrl('https://user:pw@switch.example.com')).toThrow(/credentials/);
    expect(() => normalizeServerUrl('https://switch.example.com/?x=1')).toThrow(/query/);
    expect(() => normalizeServerUrl('switch.example.com')).toThrow(/not a URL/);
  });

  it('refuses them as configuration errors, which a restart cannot fix', () => {
    expect(() => normalizeServerUrl('http://switch.example.com')).toThrow(ConfigurationError);
    expect(() => normalizeServerUrl('switch.example.com')).toThrow(ConfigurationError);
  });
});

describe('enroll', () => {
  it.each([
    ['an HTML page', '<html>Not Found</html>'],
    ['a framework 404', '{"detail":"Not Found"}'],
  ])('says a server answering 404 with %s is probably not the Switch API', async (_label, text) => {
    const notSwitch = async () => new Response(text, { status: 404 });
    const error = await enroll(notSwitch, 'https://switch.example.test', {
      proof: { kind: 'enrollment_code', code: 'swce_example' },
      controller: {
        kind: 'daemon',
        name: 'host',
        platform: { os: 'linux', arch: 'x64', os_version: '6.1' },
        version: '0.1.0',
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ControllerApiError);
    expect(error).toMatchObject({ status: 404, code: 'not_switch_api', retryable: false });
    expect((error as Error).message).toContain(
      'https://switch.example.test has no enrollment route'
    );
    expect((error as Error).message).toContain('probably not the Switch API URL');
  });

  it('exchanges an enrollment code for an id and a credential', async () => {
    const result = await enroll(fetch, core.url, {
      proof: { kind: 'enrollment_code', code: core.enrollmentCode },
      controller: {
        kind: 'daemon',
        name: 'box',
        platform: { os: 'linux', arch: 'x64', os_version: '6.1' },
        version: '0.1.0',
      },
    });
    expect(result).toEqual({ controller_id: core.controllerId, credential: core.credential });
    const request = core.requests.at(-1)!;
    expect(request.headers[PROTOCOL_HEADER.toLowerCase()]).toBe('1');
    expect(request.headers['idempotency-key']).toBeTruthy();
  });

  it('surfaces a refused code as a typed error from the envelope', async () => {
    const error = await enroll(fetch, core.url, {
      proof: { kind: 'enrollment_code', code: 'wrong' },
      controller: {
        kind: 'daemon',
        name: 'box',
        platform: { os: 'linux', arch: 'x64', os_version: '6.1' },
        version: '0.1.0',
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ControllerApiError);
    expect(error).toMatchObject({ status: 400, code: 'enrollment_code_invalid', retryable: false });
  });
});

describe('access tokens', () => {
  it('exchanges once and reuses the token', async () => {
    const { client: api } = client();
    await api.putStatus(statusReport());
    await api.pendingOperations();
    expect(core.tokensIssued).toBe(1);
    const authorization = core.requests.at(-1)!.headers.authorization;
    expect(authorization).toBe('Bearer access-token-1');
  });

  it('refreshes once 80% of the lifetime has passed', async () => {
    core.tokenLifetimeMs = 100_000;
    const { client: api } = client();
    await api.pendingOperations();
    clock += 79_000;
    await api.pendingOperations();
    expect(core.tokensIssued).toBe(1);
    clock += 2_000;
    await api.pendingOperations();
    expect(core.tokensIssued).toBe(2);
  });

  it('shares one exchange between concurrent callers', async () => {
    const { tokens } = client();
    const [a, b] = await Promise.all([tokens.get(), tokens.get()]);
    expect(a).toBe(b);
    expect(core.tokensIssued).toBe(1);
  });

  it('exchanges again and retries once when a token is refused', async () => {
    const { client: api } = client();
    await api.pendingOperations();
    core.expireTokens();
    await expect(api.pendingOperations()).resolves.toEqual([]);
    expect(core.tokensIssued).toBe(2);
  });

  it('gives up after the retry is refused too', async () => {
    const { client: api } = client();
    core.scripted.push(
      ...[1, 2].map(() => ({
        method: 'GET',
        path: `/v1/management/controllers/${core.controllerId}/operations`,
        status: 401,
        body: { error: { code: 'token_expired', message: 'expired', retryable: true } },
      }))
    );
    await expect(api.pendingOperations()).rejects.toMatchObject({ code: 'token_expired' });
    expect(core.tokensIssued).toBe(2);
  });

  it('does not retry a revoked controller', async () => {
    const { client: api } = client();
    await api.pendingOperations();
    core.revoked = true;
    await expect(api.pendingOperations()).rejects.toMatchObject({
      status: 401,
      code: 'controller_revoked',
    });
    expect(core.tokensIssued).toBe(1);
  });

  it('reports a wrong credential from the exchange', async () => {
    const { client: api } = client('not-the-credential');
    await expect(api.pendingOperations()).rejects.toMatchObject({ code: 'invalid_credential' });
  });
});

describe('assignment', () => {
  it('returns the assignment with its ETag, then 304 for the same ETag', async () => {
    core.setAssignment(assignment);
    const { client: api } = client();
    const first = await api.assignment(null);
    expect(first).toEqual({ kind: 'changed', assignment, etag: '"2"' });
    const second = await api.assignment('"2"');
    expect(second).toEqual({ kind: 'unchanged' });
    expect(core.requests.at(-1)!.headers['if-none-match']).toBe('"2"');
    core.setAssignment({ ...assignment, revision: 3 });
    expect(await api.assignment('"2"')).toMatchObject({ kind: 'changed', etag: '"3"' });
  });

  it('refuses an assignment that does not match the protocol', async () => {
    const { client: api } = client();
    core.scripted.push({
      method: 'GET',
      path: `/v1/management/controllers/${core.controllerId}/assignment`,
      status: 200,
      body: { revision: 'three', agents: [] },
    });
    await expect(api.assignment(null)).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('errors', () => {
  it('reads code, retryable and retry_after_s from the envelope', async () => {
    const { client: api } = client();
    core.scripted.push({
      method: 'GET',
      path: `/v1/management/controllers/${core.controllerId}/operations`,
      status: 503,
      body: { error: { code: 'internal', message: 'busy', retryable: true, retry_after_s: 7 } },
    });
    const error = await api.pendingOperations().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ControllerApiError);
    expect(error).toMatchObject({
      status: 503,
      code: 'internal',
      message: 'busy',
      retryable: true,
      retryAfterS: 7,
    });
  });

  it('still raises on a response without an envelope', async () => {
    const { client: api } = client();
    core.scripted.push({
      method: 'GET',
      path: `/v1/management/controllers/${core.controllerId}/operations`,
      status: 502,
      body: 'bad gateway',
    });
    await expect(api.pendingOperations()).rejects.toMatchObject({
      status: 502,
      code: 'internal',
      retryable: true,
    });
  });
});

describe('the controller stream routes', () => {
  it('opens a connection declaring itself and its cursors, beats it, and attaches the stream', async () => {
    core.setAssignment(assignment);
    const { client: api } = client();
    const signal = new AbortController().signal;
    const opened = await api.openConnection(
      { 'agent-1': 41, 'agent-2': 'head' },
      { 'agent-1': ['room-a'] },
      signal
    );
    expect(opened.agents).toEqual(['agent-1']);
    const sent = core.requests.at(-1)!;
    expect(controllerConnectionRequestSchema.parse(sent.body)).toEqual({
      client: 'switch-agent-controller',
      client_version: '0.1.0',
      cursors: { 'agent-1': 41, 'agent-2': 'head' },
      placements: { 'agent-1': ['room-a'] },
    });
    const connection = { connectionId: opened.connection_id, generation: opened.generation };
    const stream = new AbortController();
    const response = await api.openEvents(connection, stream.signal);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    await api.beat(connection, { 'agent-1': 42 }, { 'agent-1': ['room-a', 'room-b'] }, signal);
    expect(controllerBeatRequestSchema.parse(core.requests.at(-1)!.body)).toEqual({
      connection_id: opened.connection_id,
      generation: opened.generation,
      cursors: { 'agent-1': 42 },
      placements: { 'agent-1': ['room-a', 'room-b'] },
    });
    stream.abort();
  });

  it('reads the refusals that decide between reopening and stopping', async () => {
    const { client: api } = client();
    const signal = new AbortController().signal;
    await expect(
      api.beat({ connectionId: 'nobody', generation: 1 }, {}, {}, signal)
    ).rejects.toMatchObject({ status: 404, code: 'unknown_connection' });
    const first = await api.openConnection({}, {}, signal);
    await api.openConnection({}, {}, signal);
    await expect(
      api.beat({ connectionId: first.connection_id, generation: first.generation }, {}, {}, signal)
    ).rejects.toMatchObject({ status: 409, code: 'taken_over' });
  });

  it('reads a refusal in the agent bridge’s own envelope', async () => {
    const { client: api } = client();
    core.scripted.push({
      method: 'POST',
      path: `/v1/controllers/${core.controllerId}/connection/beat`,
      status: 409,
      body: { detail: { code: 'no_stream', message: 'open the stream' } },
    });
    await expect(
      api.beat({ connectionId: 'c', generation: 1 }, {}, {}, new AbortController().signal)
    ).rejects.toMatchObject({ status: 409, code: 'no_stream', message: 'open the stream' });
  });
});

describe('operations', () => {
  it('lists, claims, renews and reports', async () => {
    const { client: api } = client();
    core.addOperation({
      id: 'op-1',
      kind: 'agent.restart',
      agent_id: 'agent-1',
      params: {},
      created_at: '2026-01-01T00:00:00Z',
    });
    expect((await api.pendingOperations()).map((op) => op.id)).toEqual(['op-1']);
    const claimed = await api.claimOperation('op-1');
    expect(claimed.lease_expires_at).toBeTruthy();
    await expect(api.claimOperation('op-1')).rejects.toMatchObject({
      status: 409,
      code: 'already_claimed',
    });
    await api.operationProgress('op-1', 'working');
    await api.operationResult('op-1', { outcome: 'succeeded' });
    expect(core.results.get('op-1')).toEqual({ outcome: 'succeeded' });
    expect(core.requests.at(-1)!.headers['idempotency-key']).toBe('result-op-1');
  });
});

function statusReport() {
  return {
    seq: 1,
    observed_at: new Date().toISOString(),
    controller: { version: '0.1.0', protocol: 1 as const, assignment_revision: 0 },
    machine: {
      platform: { os: 'linux', arch: 'x64', os_version: '6.1' },
      disk_free_bytes: 1,
      disk_total_bytes: 2,
      mem_free_bytes: 1,
      mem_total_bytes: 2,
      sessions_running: 0,
      sessions_max: 0,
    },
    providers: [],
    tools: [],
    agents: [],
  };
}
