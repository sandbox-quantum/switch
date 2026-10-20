import type { ChatActivityItem } from '@shared/core/chats/activity';

/**
 * The Switch tools that create rooms, rename them, archive them or change who
 * is in them. When an agent's call to one completes, the room lists on screen
 * are out of date.
 */
const ROOM_CHANGING_TOOLS = [
  'create_room',
  'create_room_from_yaml',
  'update_room',
  'archive_room',
  'unarchive_room',
  'invite_agent_to_room',
  'add_users_to_room',
  'run_template',
];

/**
 * The tool name as each provider titles a Switch tool call: Claude Code
 * `mcp__switch__create_room`, Codex `switch.create_room`, OpenCode
 * `switch_create_room`.
 */
const ROOM_CHANGING_TITLE = new RegExp(
  `^(?:mcp__switch__|switch[._])(?:${ROOM_CHANGING_TOOLS.join('|')})(?:\\s|$)`
);

/** Whether an activity row is a finished Switch tool call that changed rooms. */
export function changesRooms(item: Pick<ChatActivityItem, 'kind' | 'status' | 'title'>): boolean {
  return (
    item.kind === 'tool-activity' &&
    item.status === 'completed' &&
    ROOM_CHANGING_TITLE.test(item.title)
  );
}
