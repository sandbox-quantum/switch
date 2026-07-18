import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRow } from '@main/db/schema';
import { renameSession } from './renameSession';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@main/db/client', () => ({
  db: {
    select: mocks.select,
    update: mocks.update,
  },
}));

function makeSessionRow(values: Partial<SessionRow>): SessionRow {
  return {
    id: values.id ?? 'session-1',
    agentId: values.agentId ?? 'agent-1',
    title: values.title ?? 'old-title',
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
    statusChangedAt: values.statusChangedAt ?? '2026-05-28 12:00:00',
    createdAt: values.createdAt ?? '2026-05-28 12:00:00',
    updatedAt: values.updatedAt ?? '2026-05-28 12:00:00',
  };
}

function mockSelectRows(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn(() => ({ limit }));
  const innerJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ innerJoin }));
  mocks.select.mockReturnValue({ from });
  return { from, innerJoin, where, limit };
}

function mockUpdateRows(rows: SessionRow[]) {
  const returning = vi.fn().mockResolvedValue(rows);
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  mocks.update.mockReturnValue({ set });
  return { set, where, returning };
}

describe('renameSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renames the session title and nothing else', async () => {
    const updatedRow = makeSessionRow({ title: 'new-title' });

    mockSelectRows([{ providerId: 'claude' }]);
    const update = mockUpdateRows([updatedRow]);

    const result = await renameSession('session-1', 'new-title');

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.session.title).toBe('new-title');
    expect(update.set).toHaveBeenCalledWith(expect.objectContaining({ title: 'new-title' }));
  });

  it('returns session-not-found when the session does not exist', async () => {
    mockSelectRows([]);

    const result = await renameSession('missing-session', 'new-title');

    expect(result).toEqual({
      success: false,
      error: { type: 'session-not-found', sessionId: 'missing-session' },
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
