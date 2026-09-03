import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? os.tmpdir() : '/tmp') },
}));

const mockGetAgents = vi.fn();
const mockGetAgentById = vi.fn();
const mockGetSession = vi.fn();
const mockCreateSession = vi.fn();
const mockTeardown = vi.fn();
const mockGetSessions = vi.fn();
const mockSidecarRestart = vi.fn();
const mockSidecarStop = vi.fn();
const mockSidecarGetStatus = vi.fn();

vi.mock('@main/core/agents/getAgents', () => ({ getAgents: mockGetAgents }));
vi.mock('@main/core/agents/getAgentById', () => ({ getAgentById: mockGetAgentById }));
vi.mock('@main/core/sessions/operations/getSession', () => ({ getSession: mockGetSession }));
vi.mock('@main/core/sessions/session-service', () => ({
  sessionService: {
    getSessions: mockGetSessions,
    createSession: mockCreateSession,
    teardown: mockTeardown,
  },
}));
vi.mock('@main/core/sidecar/controller', () => ({
  sidecarController: {
    restart: mockSidecarRestart,
    stop: mockSidecarStop,
    getStatus: mockSidecarGetStatus,
  },
}));
vi.mock('@main/lib/logger', () => ({
  log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

// Import after mocks are set up
const { controlService } = await import('./control-service');

function request(
  port: number,
  method: string,
  urlPath: string,
  token: string,
  body?: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path: urlPath,
        headers: {
          'x-switch-control-token': token,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => resolve({ status: res.statusCode!, body: data }));
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const AGENT_A = {
  id: 'agent-aaa',
  name: 'test-agent',
  locationId: 'loc-1',
  providerId: 'claude-code',
  switchAgentId: null,
  apiEndpoint: null,
  serverId: null,
  status: null,
  autoApprove: false,
  providerConfig: null,
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
};

const SESSION_1 = {
  id: 'session-111',
  agentId: 'agent-aaa',
  providerId: 'claude-code',
  title: 'Test session',
  shellId: 'xterm',
  status: 'in_progress',
  statusChangedAt: '2025-01-01T00:00:00Z',
  agentSessionId: null,
  isInitialSession: false,
  isPinned: false,
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
};

describe('ControlService routes', () => {
  let port: number;
  let token: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    await controlService.initialize();
    port = controlService.getPort();
    token = controlService.getToken();
  });

  afterEach(() => {
    controlService.dispose();
  });

  describe('GET /agents', () => {
    it('returns the agent list', async () => {
      mockGetAgents.mockResolvedValue([AGENT_A]);
      const res = await request(port, 'GET', '/agents', token);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ agents: [AGENT_A] });
    });
  });

  describe('GET /agents/:agentId', () => {
    it('returns a single agent', async () => {
      mockGetAgentById.mockResolvedValue(AGENT_A);
      const res = await request(port, 'GET', '/agents/agent-aaa', token);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ agent: AGENT_A });
    });

    it('returns 404 for unknown agent', async () => {
      mockGetAgentById.mockResolvedValue(undefined);
      const res = await request(port, 'GET', '/agents/nonexistent', token);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /agents/:agentId/sessions', () => {
    it('returns sessions for the agent', async () => {
      mockGetAgentById.mockResolvedValue(AGENT_A);
      mockGetSessions.mockResolvedValue([
        SESSION_1,
        { ...SESSION_1, id: 'other', agentId: 'other' },
      ]);
      const res = await request(port, 'GET', '/agents/agent-aaa/sessions', token);
      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body);
      expect(parsed.sessions).toHaveLength(1);
      expect(parsed.sessions[0].id).toBe('session-111');
    });

    it('returns 404 for unknown agent', async () => {
      mockGetAgentById.mockResolvedValue(undefined);
      const res = await request(port, 'GET', '/agents/nonexistent/sessions', token);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /agents/:agentId/sessions', () => {
    it('creates a session', async () => {
      mockGetAgentById.mockResolvedValue(AGENT_A);
      mockCreateSession.mockResolvedValue({ success: true, data: SESSION_1 });
      const res = await request(
        port,
        'POST',
        '/agents/agent-aaa/sessions',
        token,
        JSON.stringify({ title: 'New session' })
      );
      expect(res.status).toBe(201);
      expect(JSON.parse(res.body)).toEqual({ session: SESSION_1 });
      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'agent-aaa', title: 'New session' })
      );
    });

    it('returns 422 on creation failure', async () => {
      mockGetAgentById.mockResolvedValue(AGENT_A);
      mockCreateSession.mockResolvedValue({
        success: false,
        error: { type: 'agent-not-found' },
      });
      const res = await request(
        port,
        'POST',
        '/agents/agent-aaa/sessions',
        token,
        JSON.stringify({})
      );
      expect(res.status).toBe(422);
    });

    it('returns 404 for unknown agent', async () => {
      mockGetAgentById.mockResolvedValue(undefined);
      const res = await request(
        port,
        'POST',
        '/agents/nonexistent/sessions',
        token,
        JSON.stringify({})
      );
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /agents/:agentId/sessions/:sessionId', () => {
    it('tears down a session', async () => {
      mockGetAgentById.mockResolvedValue(AGENT_A);
      mockGetSession.mockResolvedValue(SESSION_1);
      mockTeardown.mockResolvedValue({ success: true, data: undefined });
      const res = await request(port, 'DELETE', '/agents/agent-aaa/sessions/session-111', token);
      expect(res.status).toBe(200);
      expect(mockTeardown).toHaveBeenCalledWith('session-111', 'terminate');
    });

    it('returns 404 for unknown session', async () => {
      mockGetAgentById.mockResolvedValue(AGENT_A);
      mockGetSession.mockResolvedValue(null);
      const res = await request(port, 'DELETE', '/agents/agent-aaa/sessions/nonexistent', token);
      expect(res.status).toBe(404);
    });

    it('returns 404 when session belongs to different agent', async () => {
      mockGetAgentById.mockResolvedValue(AGENT_A);
      mockGetSession.mockResolvedValue({ ...SESSION_1, agentId: 'other-agent' });
      const res = await request(port, 'DELETE', '/agents/agent-aaa/sessions/session-111', token);
      expect(res.status).toBe(404);
    });

    it('returns 500 when teardown fails', async () => {
      mockGetAgentById.mockResolvedValue(AGENT_A);
      mockGetSession.mockResolvedValue(SESSION_1);
      mockTeardown.mockResolvedValue({
        success: false,
        error: { type: 'timeout', message: 'timed out', timeout: 5000 },
      });
      const res = await request(port, 'DELETE', '/agents/agent-aaa/sessions/session-111', token);
      expect(res.status).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: 'timeout' });
    });
  });

  describe('POST /agents/:agentId/sidecar/restart', () => {
    it('restarts the sidecar', async () => {
      mockGetAgentById.mockResolvedValue(AGENT_A);
      const mockStatus = { agentId: 'agent-aaa', running: true };
      mockSidecarRestart.mockResolvedValue(mockStatus);
      const res = await request(port, 'POST', '/agents/agent-aaa/sidecar/restart', token);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ status: mockStatus });
    });

    it('returns 404 for unknown agent', async () => {
      mockGetAgentById.mockResolvedValue(undefined);
      const res = await request(port, 'POST', '/agents/nonexistent/sidecar/restart', token);
      expect(res.status).toBe(404);
    });

    it('returns 500 on sidecar error', async () => {
      mockGetAgentById.mockResolvedValue(AGENT_A);
      mockSidecarRestart.mockRejectedValue(new Error('ssh connection failed'));
      const res = await request(port, 'POST', '/agents/agent-aaa/sidecar/restart', token);
      expect(res.status).toBe(500);
    });
  });

  describe('GET /agents/:agentId/sidecar/status', () => {
    it('returns sidecar status', async () => {
      mockGetAgentById.mockResolvedValue(AGENT_A);
      const mockStatus = { agentId: 'agent-aaa', running: false };
      mockSidecarGetStatus.mockResolvedValue(mockStatus);
      const res = await request(port, 'GET', '/agents/agent-aaa/sidecar/status', token);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ status: mockStatus });
    });
  });

  describe('token file', () => {
    it('writes a token file on initialize and removes it on dispose', () => {
      const tokenPath = path.join(os.tmpdir(), 'control-api.json');
      expect(fs.existsSync(tokenPath)).toBe(true);
      const content = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      expect(content.port).toBe(port);
      expect(content.token).toBe(token);

      controlService.dispose();
      expect(fs.existsSync(tokenPath)).toBe(false);
    });
  });
});
