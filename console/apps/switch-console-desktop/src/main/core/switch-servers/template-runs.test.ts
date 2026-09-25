import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSessionCookie = vi.hoisted(() => vi.fn());
const refreshSession = vi.hoisted(() => vi.fn());
const reauthenticateManagedServer = vi.hoisted(() => vi.fn());
const managedServerHostBlocked = vi.hoisted(() => vi.fn(() => null));
const managedServerStoppedPhase = vi.hoisted(() => vi.fn(() => null));

vi.mock('@main/core/managed-switch-server/managed-server-status', () => ({
  managedServerHostBlocked,
  managedServerStoppedPhase,
}));
vi.mock('./servers-store', () => ({ getSessionCookie }));
vi.mock('./auth', () => ({ refreshSession, reauthenticateManagedServer }));

const { changeTemplateRun, createRoomFromTemplate, fetchTemplateRuns, GatewayError } =
  await import('./gateway-client');

const SERVER = {
  id: 'srv-1',
  name: 'S',
  gatewayUrl: 'https://switch.example.com',
  managed: false,
} as never;

function validJwt(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
  const payload = Buffer.from(JSON.stringify({ sub: 'u1', exp })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function response(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    headers: { getSetCookie: () => [] },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const RUN = {
  root_room_id: 'room/root',
  root_room_name: 'Triage',
  started_by_name: 'alice',
  template_name: 'Triage pair',
  started_at: '2026-09-25T10:00:00Z',
  last_activity_at: '2026-09-25T10:05:00Z',
  state: 'paused',
  reason: 'An agent asked to post the same kickoff on the same path again.',
  changed_by_name: null,
  paused_repeat_of: 'room/child',
  can_control: true,
  rooms: [
    {
      id: 'room/root',
      name: 'Triage',
      parent_room_id: null,
      created_by_agent_id: null,
      created_by_agent_name: null,
      template_name: 'Triage pair',
      created_at: '2026-09-25T10:00:00Z',
      archived: false,
    },
    {
      id: 'room/child',
      name: 'Triage follow-up',
      parent_room_id: 'room/root',
      created_by_agent_id: 'agent-1',
      created_by_agent_name: 'planner',
      template_name: null,
      created_at: '2026-09-25T10:03:00Z',
      archived: true,
    },
  ],
};

const fetchMock = vi.fn();

describe('template runs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    getSessionCookie.mockResolvedValue(validJwt());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the runs into camelCase', async () => {
    fetchMock.mockResolvedValue(response(200, [RUN]));

    const runs = await fetchTemplateRuns(SERVER);

    expect(fetchMock.mock.calls[0][0]).toBe('https://switch.example.com/gateway/template-runs');
    expect(runs).toEqual([
      {
        rootRoomId: 'room/root',
        rootRoomName: 'Triage',
        startedByName: 'alice',
        templateName: 'Triage pair',
        startedAt: '2026-09-25T10:00:00Z',
        lastActivityAt: '2026-09-25T10:05:00Z',
        state: 'paused',
        reason: RUN.reason,
        changedByName: null,
        pausedRepeatOf: 'room/child',
        canControl: true,
        rooms: [
          {
            id: 'room/root',
            name: 'Triage',
            parentRoomId: null,
            createdByAgentId: null,
            createdByAgentName: null,
            templateName: 'Triage pair',
            createdAt: '2026-09-25T10:00:00Z',
            archived: false,
          },
          {
            id: 'room/child',
            name: 'Triage follow-up',
            parentRoomId: 'room/root',
            createdByAgentId: 'agent-1',
            createdByAgentName: 'planner',
            templateName: null,
            createdAt: '2026-09-25T10:03:00Z',
            archived: true,
          },
        ],
      },
    ]);
  });

  it('answers null for a server that does not record runs', async () => {
    fetchMock.mockResolvedValue(response(404, { detail: 'Not Found' }));
    await expect(fetchTemplateRuns(SERVER)).resolves.toBeNull();
  });

  it('stops a run by its root room', async () => {
    fetchMock.mockResolvedValue(response(200, { ...RUN, state: 'stopped' }));

    const run = await changeTemplateRun(SERVER, 'room/root', 'stop');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://switch.example.com/gateway/template-runs/room%2Froot/stop');
    expect(init.method).toBe('POST');
    expect(run.state).toBe('stopped');
  });

  it('reports a run the user may not control', async () => {
    fetchMock.mockResolvedValue(response(403, { detail: 'Only the owner can continue this run' }));
    await expect(changeTemplateRun(SERVER, 'room/root', 'continue')).rejects.toBeInstanceOf(
      GatewayError
    );
  });

  it('names the template a room is created from', async () => {
    fetchMock.mockResolvedValue(response(200, { room_id: 'r1', room_name: 'Triage' }));

    await createRoomFromTemplate(SERVER, 'room:\n  name: Triage\n', {}, 'Triage pair');

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      yaml: 'room:\n  name: Triage\n',
      inputs: {},
      template_name: 'Triage pair',
    });
  });
});
