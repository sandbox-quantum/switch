import type { ChatMessage } from '@shared/core/chats/chats';

/**
 * A Stop is posted as `!interrupt @agent` and the agent acknowledges it in a
 * thread rooted at the command. The turn's own "Stopped" row already says it
 * stopped, so the command and that acknowledgement are not shown. Any other
 * answer (it could not be stopped) is shown with its command.
 */

/** The agent's in-room answer to an interrupt it carried out (core's `_INTERRUPT.ack`). */
export const INTERRUPT_ACK_MESSAGE = 'Interrupted my current turn.';

type Row = Pick<ChatMessage, 'messageId' | 'threadRootId' | 'body' | 'sender'>;

export function isInterruptAck(message: Pick<ChatMessage, 'body' | 'sender'>): boolean {
  return message.sender.kind !== 'human' && message.body.startsWith(INTERRUPT_ACK_MESSAGE);
}

function isInterruptCommand(message: Row): boolean {
  return message.sender.kind === 'human' && /^!interrupt(\s|$)/.test(message.body.trim());
}

/** Ids of the Stop commands and their acknowledgements to leave out of the transcript. */
export function hiddenStopRows(messages: readonly Row[]): Set<string> {
  const hidden = new Set<string>();
  for (const command of messages) {
    if (!isInterruptCommand(command)) continue;
    const answers = messages.filter(
      (each) => each.threadRootId === command.messageId && each.sender.kind !== 'human'
    );
    if (!answers.every(isInterruptAck)) continue;
    hidden.add(command.messageId);
    for (const answer of answers) hidden.add(answer.messageId);
  }
  return hidden;
}
