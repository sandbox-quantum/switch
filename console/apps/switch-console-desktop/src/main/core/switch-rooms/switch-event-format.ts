/**
 * Formatting agent-bridge events for injection into a session's terminal.
 *
 * The event *shapes* are protocol, and live in
 * `@sandbox-quantum/switch-agent-runtime`; they are re-exported here so the
 * many call sites that import both from this module keep working. What is
 * genuinely Switch Console's is below: turning an event into the line a human (and
 * an agent reading its own terminal) sees.
 */

export type {
  AgentBridgeEvent,
  AttachmentRef,
  CommandPayload,
  MessagePayload,
  RoomJoinPayload,
  TaskPayload,
} from '@sandbox-quantum/switch-agent-runtime';
import type {
  AgentBridgeEvent,
  CommandPayload,
  MessagePayload,
  RoomJoinPayload,
  TaskPayload,
} from '@sandbox-quantum/switch-agent-runtime';

/**
 * Format an agent-bridge event as a self-contained line to inject into the
 * session. Returns null for events that should not surface (unaddressed room
 * chatter, join events the agent is not listening for) — mirroring the
 * channel's filtering so the two pollers behave identically.
 *
 * `roomName` is the human-readable room name (from connect_to_room); the raw
 * room id is used as a fallback when it is unknown.
 */
export function formatEventForInjection(
  event: AgentBridgeEvent,
  roomName?: string | null
): string | null {
  const { type, payload } = event;
  const room = roomName ?? event.room_id;

  switch (type) {
    case 'message': {
      const msg = payload as MessagePayload;
      if (!msg.addressed) return null;
      // Always surface message_id; surface thread_id only when the message is
      // genuinely in a thread, so a root-level message isn't mistaken for a
      // threaded one. The agent can still open a thread on a root message by
      // replying with its message_id.
      const ids = msg.thread_id
        ? `message_id ${msg.message_id}, thread_id ${msg.thread_id}`
        : `message_id ${msg.message_id}`;
      return `[Switch] ${msg.sender_name} addressed you in room ${room} (${ids}): ${msg.body}`;
    }
    case 'command': {
      const cmd = payload as CommandPayload;
      return `[Switch] Command in room ${room}: ${cmd.command}${
        cmd.args ? ` args=${cmd.args}` : ''
      }`;
    }
    case 'room_join': {
      const join = payload as RoomJoinPayload;
      if (!join.listening) return null;
      return `[Switch] ${join.member_name} joined room ${room}`;
    }
    case 'task_delegate': {
      const task = payload as TaskPayload;
      return `[Switch] Task delegated to you in room ${room}: ${task.summary ?? ''} — ${
        task.description ?? ''
      }`;
    }
    case 'task_accept': {
      const task = payload as TaskPayload;
      return `[Switch] Task ${task.task_id} accepted by ${task.performer_agent_id}`;
    }
    case 'task_update': {
      const task = payload as TaskPayload;
      return `[Switch] Task ${task.task_id} update: ${task.update ?? ''}`;
    }
    case 'task_finalise': {
      const task = payload as TaskPayload;
      return `[Switch] Task ${task.task_id} finalised: ${task.outcome ?? '(no outcome provided)'}`;
    }
    case 'task_cancel': {
      const task = payload as TaskPayload;
      return `[Switch] Task ${task.task_id} cancelled${task.reason ? `: ${task.reason}` : ''}`;
    }
    default:
      return null;
  }
}

/**
 * Annotation appended to an injected message that carried attachments.
 * Unlike the connector channel — which surfaces them as `image_path` /
 * `file_path` notification attributes plus a static instruction — the pollers
 * inject plain text into a PTY/tmux pane and have no separate metadata
 * channel, so the annotation itself must both signal the attachments and tell
 * the agent how to read them.
 *
 * Images and other files are named separately because the agent treats them
 * differently (an image is Read to be seen; a `.md`/`.csv`/`.pdb` is Read to be
 * parsed). `failed` names attachments that could not be downloaded: they are
 * reported rather than omitted, so the agent never silently believes it saw
 * everything the sender attached.
 */
export function formatAttachmentAnnotation(
  imagePaths: string[],
  filePaths: string[],
  failed: string[] = []
): string | null {
  const parts: string[] = [];
  if (imagePaths.length > 0) {
    const noun = imagePaths.length === 1 ? 'image' : 'images';
    parts.push(
      `${imagePaths.length} ${noun} attached — downloaded to ${imagePaths.join(', ')}. Read ${
        imagePaths.length === 1 ? 'it' : 'them'
      } to view.`
    );
  }
  if (filePaths.length > 0) {
    const noun = filePaths.length === 1 ? 'file' : 'files';
    parts.push(
      `${filePaths.length} ${noun} attached — downloaded to ${filePaths.join(', ')}. Read ${
        filePaths.length === 1 ? 'it' : 'them'
      } to see the contents.`
    );
  }
  if (failed.length > 0) {
    parts.push(
      `${failed.length} attachment${failed.length === 1 ? '' : 's'} could NOT be retrieved (${failed.join(
        ', '
      )}) — do not assume you have seen ${failed.length === 1 ? 'it' : 'them'}.`
    );
  }
  if (parts.length === 0) return null;
  return `(${parts.join(' ')})`;
}
