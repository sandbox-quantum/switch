import type { ChatMessage } from '../contracts/chats';
import { attachmentFilename } from './attachment-filename';

/**
 * A message's text as shown. A file posted without a caption carries its name
 * as the message's text, so that text is shown as the file's name is
 * ({@link attachmentFilename}); otherwise the line above a file named
 * `invoice<U+202E>fdp.exe` would still read "invoiceexe.pdf".
 */
export function messageText(message: Pick<ChatMessage, 'body' | 'attachments'>): string {
  return message.attachments.some((attachment) => attachment.filename === message.body)
    ? attachmentFilename(message.body)
    : message.body;
}
