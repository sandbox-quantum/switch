import { afterEach, describe, expect, it, vi } from 'vitest';
import { Redactions } from './redaction';
import type { ServiceTokenAnswer } from './service-access';
import { type ServiceEndpointServer, startServiceEndpoint } from './service-endpoint';
import { ServiceNotices } from './service-notices';
import type { HostAsk } from './session-channel';

const servers: ServiceEndpointServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function endpoint(
  answers: (ServiceTokenAnswer | Error)[],
  services = ['github'],
  unavailable: string | null = null
) {
  const asked: HostAsk[] = [];
  const redactions = new Redactions();
  const notices = new ServiceNotices();
  const shown: string[] = [];
  notices.attach(async (message) => {
    shown.push(message);
  });
  const checked: string[] = [];
  const server = await startServiceEndpoint({
    services,
    unavailable,
    redactions,
    notices,
    fallback: true,
    // The token reaches `org/granted`; GitHub cannot say for `org/unknown`.
    repositoryVisible: async (_token, repository) => {
      checked.push(repository);
      return repository === 'org/unknown' ? null : repository === 'org/granted';
    },
    ask: async (ask) => {
      asked.push(ask);
      const next = answers.shift();
      if (!next || next instanceof Error) throw next ?? new Error('no answer left');
      return next;
    },
  });
  servers.push(server);
  const post = (service: string, body: unknown, token = server.token) =>
    fetch(`${server.url}/services/${service}/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { server, asked, redactions, post, shown, checked };
}

const HOUR_LATER = new Date(Date.now() + 3_600_000).toISOString();

describe('the session service endpoint', () => {
  it('serves on loopback only, to the bearer minted for this session', async () => {
    const e = await endpoint([{ kind: 'token', token: 'synthetic-one', expiresAt: HOUR_LATER }]);
    expect(e.server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await e.post('github', { rejected: null }, 'someone-else')).status).toBe(401);
    const response = await e.post('github', { rejected: null });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ token: 'synthetic-one', expires_at: HOUR_LATER });
    expect(e.asked).toEqual([{ type: 'service-token', service: 'github', rejected: null }]);
    expect(e.redactions.text('synthetic-one')).toBe('[REDACTED]');
  });

  it('passes on a token a helper found refused', async () => {
    const e = await endpoint([{ kind: 'token', token: 'synthetic-two', expiresAt: HOUR_LATER }]);
    await e.post('github', { rejected: 'synthetic-one' });
    expect(e.asked).toEqual([
      { type: 'service-token', service: 'github', rejected: 'synthetic-one' },
    ]);
  });

  it('serves no service without a machine helper, even one granted', async () => {
    const e = await endpoint([], ['github', 'jira']);
    const response = await e.post('jira', { rejected: null });
    expect(response.status).toBe(404);
    expect(e.asked).toEqual([]);
  });

  it('serves only the services granted when the session started', async () => {
    const e = await endpoint([]);
    const response = await e.post('jira', { rejected: null });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toContain(
      'no jira grant when this session started'
    );
    expect(e.asked).toEqual([]);
  });

  it('answers no token, asking nothing, when the grants could not be read, and says so once', async () => {
    const e = await endpoint([], [], 'Switch refused (HTTP 503)');
    const response = await e.post('github', { rejected: null });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toContain(
      'Switch refused (HTTP 503)'
    );
    await e.post('github', { rejected: null });
    expect(e.asked).toEqual([]);
    expect(e.shown).toHaveLength(1);
    expect(e.shown[0]).toContain("git and gh use this machine's own GitHub sign-in instead");
  });

  it('refuses a repository outside the grant, asking GitHub once, and says so once', async () => {
    const token = { kind: 'token' as const, token: 'synthetic-one', expiresAt: HOUR_LATER };
    const e = await endpoint([token, token, token]);

    const outside = await e.post('github', { rejected: null, repository: 'org/other' });
    expect(outside.status).toBe(403);
    expect(((await outside.json()) as { error: string }).error).toBe(
      "org/other is not in this agent's github grant."
    );
    expect((await e.post('github', { rejected: null, repository: 'Org/Other' })).status).toBe(403);
    expect((await e.post('github', { rejected: null, repository: 'org/granted' })).status).toBe(
      200
    );

    expect(e.checked).toEqual(['org/other', 'org/granted']);
    expect(e.shown).toEqual([
      "org/other is not in this agent's GitHub grant, so git and gh use this machine's own GitHub sign-in for it, if it has one.",
    ]);
  });

  it('hands out the token when GitHub cannot say whether it reaches the repository', async () => {
    const e = await endpoint([{ kind: 'token', token: 'synthetic-one', expiresAt: HOUR_LATER }]);
    const response = await e.post('github', { rejected: null, repository: 'org/unknown' });
    expect(response.status).toBe(200);
    expect(e.shown).toEqual([]);
  });

  it('says nothing when it hands out a token', async () => {
    const e = await endpoint([{ kind: 'token', token: 'synthetic-one', expiresAt: HOUR_LATER }]);
    expect((await e.post('github', { rejected: null })).status).toBe(200);
    expect(e.shown).toEqual([]);
  });

  it("stops serving a service for the session on Switch's final refusal", async () => {
    const e = await endpoint([
      {
        kind: 'refused',
        code: 'grant_missing',
        message: 'The GitHub grant was removed.',
        final: true,
      },
    ]);
    for (let i = 0; i < 2; i++) {
      const response = await e.post('github', { rejected: null });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'The GitHub grant was removed.' });
    }
    expect(e.asked).toHaveLength(1);
  });

  it('says why when a token cannot be had for now, and asks again next time', async () => {
    const e = await endpoint([
      { kind: 'refused', code: 'internal', message: 'GitHub is down.', final: false },
      new Error('No room watcher is running for agent agent here.'),
    ]);
    const first = await e.post('github', { rejected: null });
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ error: 'GitHub is down.' });
    const second = await e.post('github', { rejected: null });
    expect(second.status).toBe(503);
    expect(((await second.json()) as { error: string }).error).toContain('No room watcher');
  });

  it('refuses a malformed request without stopping', async () => {
    const e = await endpoint([{ kind: 'token', token: 'synthetic-one', expiresAt: HOUR_LATER }]);
    expect((await e.post('github', '{not json')).status).toBe(400);
    expect((await e.post('github', { rejected: 7 })).status).toBe(400);
    expect((await e.post('github', { rejected: null })).status).toBe(200);
  });

  it('gives up on an agent host that does not answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const server = await startServiceEndpoint({
        services: ['github'],
        unavailable: null,
        notices: new ServiceNotices(),
        fallback: true,
        repositoryVisible: async () => null,
        redactions: new Redactions(),
        ask: () => new Promise(() => {}),
      });
      servers.push(server);
      const pending = fetch(`${server.url}/services/github/token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${server.token}` },
        body: JSON.stringify({ rejected: null }),
      });
      await vi.waitFor(() => vi.getTimerCount() > 0 || Promise.reject(new Error('not yet')));
      await vi.advanceTimersByTimeAsync(90_000);
      const response = await pending;
      expect(response.status).toBe(503);
      expect(((await response.json()) as { error: string }).error).toContain('did not answer');
    } finally {
      vi.useRealTimers();
    }
  });
});
