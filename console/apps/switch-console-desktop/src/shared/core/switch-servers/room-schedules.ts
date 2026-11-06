export type RoomScheduleInput = {
  body: string;
  agentIds: string[];
  timezone: string;
  cron: string | null;
  runAt: string | null;
};

export type RemoteRoomSchedule = Omit<RoomScheduleInput, 'runAt'> & {
  id: string;
  authorAgentId: string | null;
  nextRunAt: string | null;
  paused: boolean;
  lastError: string | null;
  lastRunAt: string | null;
};
