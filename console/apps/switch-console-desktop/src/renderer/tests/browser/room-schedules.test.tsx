import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteRoomDetail, RemoteRoomSchedule } from '@shared/core/switch-servers/switch-servers';

const listRoomSchedules = vi.hoisted(() => vi.fn());
const createRoomSchedule = vi.hoisted(() => vi.fn());
const updateRoomSchedule = vi.hoisted(() => vi.fn());
const pauseRoomSchedule = vi.hoisted(() => vi.fn());
const resumeRoomSchedule = vi.hoisted(() => vi.fn());
const deleteRoomSchedule = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: vi.fn() },
  rpc: {
    workspaces: {
      listRoomSchedules,
      createRoomSchedule,
      updateRoomSchedule,
      pauseRoomSchedule,
      resumeRoomSchedule,
      deleteRoomSchedule,
      listAgents: vi.fn(() => Promise.resolve([])),
    },
    agents: { getAgents: vi.fn(() => Promise.resolve([])) },
  },
}));

vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: {
    roomWorkspaceId: () => 'ws-1',
    canDeleteRoom: () => true,
  },
}));

vi.mock('@renderer/lib/stores/use-workspace-agents', () => ({
  useWorkspaceAgents: () => ({
    data: [
      { id: 'agent-1', name: 'Claude', displayName: 'Claude Agent' },
      { id: 'agent-2', name: 'Codex', displayName: 'Codex Agent' },
    ],
  }),
}));

import { RoomSchedulesSection } from '@renderer/features/switch-rooms/schedules/room-schedules-section';

const SAMPLE_SCHEDULE: RemoteRoomSchedule = {
  id: 'sched-1',
  roomId: 'room-1',
  name: 'Daily Standup',
  scheduleType: 'recurring',
  cronExpr: '0 9 * * 1-5',
  timezone: 'UTC',
  runAt: null,
  message: 'Please post your daily standup updates!',
  targetAgentIds: ['agent-1'],
  status: 'active',
  missedRunPolicy: 'run_once',
  nextRunAt: '2026-11-05T09:00:00Z',
  lastRunAt: '2026-11-04T09:00:00Z',
  lastRunStatus: 'success',
  lastRunError: null,
  createdBy: 'user-1',
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
};

const ROOM: RemoteRoomDetail = {
  id: 'room-1',
  name: 'Engineering',
  description: 'Dev room',
  instructions: 'Stay focused',
  ownerId: 'user-1',
  archived: false,
  channelType: 'channel_public',
  agentCount: 2,
  createdAt: '2026-10-01T00:00:00Z',
  bridgeType: null,
  bridgeDisplayName: null,
  externalChannelUrl: null,
  agentIds: ['agent-1', 'agent-2'],
  connectedUserNames: [],
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function renderSection(): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <RoomSchedulesSection workspaceId="ws-1" room={ROOM} />
      </QueryClientProvider>
    )
  );
  for (let i = 0; i < 5; i++) await act(async () => await Promise.resolve());
  return container;
}

describe('RoomSchedulesSection', () => {
  it('renders empty state when there are no schedules', async () => {
    listRoomSchedules.mockResolvedValue([]);

    const el = await renderSection();

    expect(el.textContent).toContain('No scheduled messages');
    expect(el.textContent).toContain('Create schedule');
  });

  it('renders schedule list with schedule details', async () => {
    listRoomSchedules.mockResolvedValue([SAMPLE_SCHEDULE]);

    const el = await renderSection();

    expect(el.textContent).toContain('Daily Standup');
    expect(el.textContent).toContain('active');
    expect(el.textContent).toContain('0 9 * * 1-5');
    expect(el.textContent).toContain('Please post your daily standup updates!');
    expect(el.textContent).toContain('@Claude Agent');
  });

  it('allows pausing an active schedule', async () => {
    listRoomSchedules.mockResolvedValue([SAMPLE_SCHEDULE]);
    pauseRoomSchedule.mockResolvedValue({ ...SAMPLE_SCHEDULE, status: 'paused' });

    const el = await renderSection();

    const pauseButton = el.querySelector<HTMLButtonElement>('button[title="Pause schedule"]');
    expect(pauseButton).toBeDefined();

    await act(async () => {
      pauseButton!.click();
    });

    expect(pauseRoomSchedule).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      roomId: 'room-1',
      scheduleId: 'sched-1',
    });
  });

  it('allows deleting a schedule after confirmation', async () => {
    listRoomSchedules.mockResolvedValue([SAMPLE_SCHEDULE]);
    deleteRoomSchedule.mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const el = await renderSection();

    const deleteButton = el.querySelector<HTMLButtonElement>('button[title="Delete schedule"]');
    expect(deleteButton).toBeDefined();

    await act(async () => {
      deleteButton!.click();
    });

    expect(deleteRoomSchedule).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      roomId: 'room-1',
      scheduleId: 'sched-1',
    });
  });
});
