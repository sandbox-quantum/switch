import { type BuddyRefusal, REFUSAL_CODES } from '@switch-console/chat-ui/model/buddy-setup-step';
import { chatFailure } from '@renderer/features/chats/chat-errors';
import { RpcError } from '@shared/lib/ipc/rpc-error';

/** The linked-account refusal in a failed hand-off or resume, else null. */
export function buddyHandoffRefusal(cause: unknown): BuddyRefusal | null {
  if (!(cause instanceof RpcError) || cause.code !== 'ChatApiError') return null;
  const code = cause.stringField('apiCode');
  if (!code || !REFUSAL_CODES.includes(code)) return null;
  return { code: code as BuddyRefusal['code'], message: chatFailure(cause).message };
}
