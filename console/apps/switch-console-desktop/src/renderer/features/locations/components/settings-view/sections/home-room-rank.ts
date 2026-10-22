import type {
  RemoteAgentRoom,
  RemoteRoomSummary,
} from '@shared/core/switch-servers/switch-servers';

/** A room offered as an agent's home, with what makes it a likely pick. */
export type HomeRoomOption = {
  value: string;
  label: string;
  /** A short note beside the name: where the room lives, and why it is suggested. */
  detail: string;
};

/** How many of the likeliest rooms lead the list, above every room by name. */
export const SUGGESTED_HOME_ROOMS = 5;

/**
 * The rooms an agent's shared session could be based in, split into the few
 * likeliest and every room by name.
 *
 * A home room is where the agent is mostly addressed, so the likely ones are
 * those it is already active in (a live session there), those already sharing
 * its session, and rooms with people and other agents in them over rooms only
 * it uses. Nothing here reads activity history, which Console does not have;
 * the list is a shortcut, and the search finds the rest.
 */
export function homeRoomOptions(
  rooms: readonly RemoteAgentRoom[],
  summaryOf: (roomId: string) => RemoteRoomSummary | null
): { suggested: HomeRoomOption[]; all: HomeRoomOption[] } {
  const live = rooms.filter((room) => !room.archived);
  const scored = live.map((room) => {
    const summary = summaryOf(room.roomId);
    const reasons: string[] = [];
    let score = 0;
    if (room.status === 'live') {
      score += 8;
      reasons.push('active here');
    }
    if (room.sharedSession === 'shared') {
      score += 4;
      reasons.push('shares the session');
    }
    if (summary?.bridgeType) score += 2;
    if ((summary?.agentCount ?? 0) > 1) score += 1;
    const where = summary?.bridgeDisplayName ?? (summary ? 'No messaging app' : '');
    return {
      score,
      option: {
        value: room.roomId,
        label: summary?.name ?? room.roomName,
        detail: [where, ...reasons].filter(Boolean).join(' · '),
      },
    };
  });
  const byName = (a: HomeRoomOption, b: HomeRoomOption) => a.label.localeCompare(b.label);
  const suggested = scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || byName(a.option, b.option))
    .slice(0, SUGGESTED_HOME_ROOMS)
    .map((entry) => entry.option);
  const taken = new Set(suggested.map((option) => option.value));
  const all = scored
    .map((entry) => entry.option)
    .filter((option) => !taken.has(option.value))
    .sort(byName);
  return { suggested, all };
}
