import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRow } from '@main/db/schema';
import { createSession } from './createSession';

const mocks = vi.hoisted(() => ({
  getAgentById: vi.fn(),
  getProject: vi.fn(),
  insert: vi.fn(),
  deleteFn: vi.fn(),
  provisionSessionRuntime: vi.fn(),
  registerSession: vi.fn(),
  startSession: vi.fn(),
}));

vi.mock('@main/core/agents/getAgentById', () => ({
  getAgentById: mocks.getAgentById,
}));

vi.mock('@main/core/projects/project-manager', () => ({
  projectManager: { getProject: mocks.getProject },
}));

vi.mock('@main/db/client', () => ({
  db: {
    insert: mocks.insert,
    delete: mocks.deleteFn,
  },
}));

vi.mock('../session-builder', () => ({
  provisionSessionRuntime: mocks.provisionSessionRuntime,
}));

vi.mock('../session-runtime-manager', () => ({
  sessionRuntimeManager: { registerSession: mocks.registerSession },
}));

function makeSessionRow(values: Partial<SessionRow>): SessionRow {
  return {
    id: values.id ?? 'session-1',
    agentId: values.agentId ?? 'agent-1',
    title: values.title ?? 'Test Session',
    config: values.config ?? null,
    shellId: values.shellId ?? 'system',
    status: values.status ?? 'in_progress',
    agentSessionId: values.agentSessionId ?? null,
    agentStatus: values.agentStatus ?? null,
    agentStatusSeen: values.agentStatusSeen ?? 1,
    isInitialSession: values.isInitialSession ?? false,
    isPinned: values.isPinned ?? 0,
    archivedAt: values.archivedAt ?? null,
    lastInteractedAt: values.lastInteractedAt ?? null,
    statusChangedAt: values.statusChangedAt ?? '2026-05-18 12:00:00',
    createdAt: values.createdAt ?? '2026-05-18 12:00:00',
    updatedAt: values.updatedAt ?? '2026-05-18 12:00:00',
  };
}

function setupInsertMock(options: { conflict?: boolean } = {}) {
  mocks.insert.mockReturnValue({
    values: (vals: Partial<SessionRow>) => ({
      onConflictDoNothing: () => ({
        returning: () => Promise.resolve(options.conflict ? [] : [makeSessionRow(vals)]),
      }),
    }),
  });
  mocks.deleteFn.mockReturnValue({ where: () => Promise.resolve() });
}

const baseParams = {
  id: 'session-1',
  agentId: 'agent-1',
  title: 'Test Session',
};

describe('createSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAgentById.mockResolvedValue({
      id: 'agent-1',
      projectId: 'project-1',
      providerId: 'claude',
    });
    mocks.getProject.mockReturnValue({ projectId: 'project-1', repoPath: '/repo', ctx: {} });
    mocks.provisionSessionRuntime.mockResolvedValue({
      path: '/repo',
      workspaceId: 'project-1',
      agent: { start: mocks.startSession },
    });
    mocks.registerSession.mockResolvedValue(undefined);
    mocks.startSession.mockResolvedValue(undefined);
    setupInsertMock();
  });

  it('returns agent-not-found when the agent does not exist', async () => {
    mocks.getAgentById.mockResolvedValue(undefined);
    const result = await createSession(baseParams);
    expect(result).toEqual({ success: false, error: { type: 'agent-not-found' } });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('inserts the session and provisions the runtime', async () => {
    const result = await createSession(baseParams);
    expect(result.success).toBe(true);
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.provisionSessionRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.registerSession).toHaveBeenCalledTimes(1);
    expect(mocks.startSession).toHaveBeenCalledTimes(1);
  });

  it('rolls back the session row and returns spawn-failed when provisioning throws', async () => {
    mocks.provisionSessionRuntime.mockRejectedValue(new Error('boom'));
    const result = await createSession(baseParams);
    expect(result).toEqual({ success: false, error: { type: 'spawn-failed', message: 'boom' } });
    expect(mocks.deleteFn).toHaveBeenCalledTimes(1);
  });

  it('returns already-exists when the id is taken, without provisioning or rollback', async () => {
    setupInsertMock({ conflict: true });
    const result = await createSession(baseParams);
    expect(result).toEqual({ success: false, error: { type: 'already-exists' } });
    expect(mocks.provisionSessionRuntime).not.toHaveBeenCalled();
    expect(mocks.deleteFn).not.toHaveBeenCalled();
  });
});
