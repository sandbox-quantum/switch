import type { ChatMessage } from '@shared/core/chats/chats';

/**
 * A Stop is posted as `!interrupt @agent`, shown as a system line ("Stop
 * requested for …"), and the agent acknowledges it in a thread rooted at it.
 * The turn's own "Stopped" row already says it stopped, so the command and
 * that acknowledgement are not shown. Any other answer (it could not be
 * stopped) is shown with its command.
 */

/** The agent's in-room answer to an interrupt it carried out (core's `_INTERRUPT.ack`). */
export const INTERRUPT_ACK_MESSAGE = 'Interrupted my current turn.';

const STOP_REQUESTED_PREFIX = 'Stop requested for ';
const RETRY_REQUESTED_PREFIX = 'Retry requested for ';

type Row = Pick<ChatMessage, 'messageId' | 'threadRootId' | 'body' | 'sender'>;

export function isInterruptAck(message: Pick<ChatMessage, 'body' | 'sender'>): boolean {
  return message.sender.kind !== 'human' && message.body.startsWith(INTERRUPT_ACK_MESSAGE);
}

/**
 * The agent's in-room answer to a Retry it passed on (core's `_RETRY.ack`). A
 * Retry is posted as `!retry @agent <message id>` ("Retry requested for …");
 * the turn it runs again shows under the message, so the command and this
 * answer are left out too.
 */
export const RETRY_ACK_MESSAGE = 'Trying that message again.';

const SYSTEM_COMMANDS: [RegExp, string][] = [
  [new RegExp(`^${STOP_REQUESTED_PREFIX}`), INTERRUPT_ACK_MESSAGE],
  [new RegExp(`^${RETRY_REQUESTED_PREFIX}`), RETRY_ACK_MESSAGE],
];

const HUMAN_COMMANDS: [RegExp, string][] = [
  [/^!interrupt(\s|$)/, INTERRUPT_ACK_MESSAGE],
  [/^!retry(\s|$)/, RETRY_ACK_MESSAGE],
];

/** Ids of the Stop and Retry commands and their acknowledgements to leave out of the transcript. */
export function hiddenStopRows(messages: readonly Row[]): Set<string> {
  const hidden = new Set<string>();
  for (const command of messages) {
    const commands =
      command.sender.kind === 'system'
        ? SYSTEM_COMMANDS
        : command.sender.kind === 'human'
          ? HUMAN_COMMANDS
          : null;
    if (commands === null) continue;
    const ack = commands.find(([pattern]) => pattern.test(command.body.trim()))?.[1];
    if (ack === undefined) continue;
    const answers = messages.filter(
      (each) => each.threadRootId === command.messageId && each.sender.kind !== 'human'
    );
    if (!answers.every((answer) => answer.body.startsWith(ack))) continue;
    hidden.add(command.messageId);
    for (const answer of answers) hidden.add(answer.messageId);
  }
  return hidden;
}

/** An agent's acknowledgement of a Stop or Retry, which the chat leaves out: never where a turn shows. */
export function isControlAck(message: Pick<ChatMessage, 'body' | 'sender'>): boolean {
  const allAcks = [...SYSTEM_COMMANDS, ...HUMAN_COMMANDS];
  return message.sender.kind !== 'human' && allAcks.some(([, ack]) => message.body.startsWith(ack));
}
