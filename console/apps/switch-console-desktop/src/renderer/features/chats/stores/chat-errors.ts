import { failureText } from '@renderer/lib/errors/describe-failure';
import { RpcError } from '@shared/lib/ipc/rpc-error';

/**
 * What a failed `/chats` call means for the chat: the person lost access, a
 * request id was reused with another payload, the server refused the message
 * on trust grounds, or something else — and whether the outcome is unknown
 * (the request may have been applied), in which case only a retry with the
 * same request id is safe.
 */
export type ChatFailure = {
  kind: 'not-a-member' | 'request-reused' | 'refused' | 'not-a-manager' | 'agent-owner' | 'other';
  message: string;
  /** The server may have applied the request; retrying with the same id is safe. */
  uncertain: boolean;
};

const API_CODES: Record<string, ChatFailure['kind']> = {
  NOT_A_MEMBER: 'not-a-member',
  REQUEST_REUSED: 'request-reused',
  MESSAGE_REFUSED: 'refused',
  NOT_A_MANAGER: 'not-a-manager',
  AGENT_OWNER: 'agent-owner',
};

export function chatFailure(error: unknown): ChatFailure {
  if (error instanceof RpcError) {
    if (error.code === 'ChatApiError') {
      const apiCode = error.stringField('apiCode') ?? '';
      return { kind: API_CODES[apiCode] ?? 'other', message: error.message, uncertain: false };
    }
    if (error.code === 'GatewayError') {
      const kind = error.stringField('kind');
      const status = error.numberField('status');
      // No answer, or a server error: the request may have landed.
      const uncertain = kind === 'network' || (status !== undefined && status >= 500);
      return { kind: 'other', message: failureText(error, 'Switch did not answer.'), uncertain };
    }
    // An answer that did not match the contract arrived after the server acted.
    return {
      kind: 'other',
      message: failureText(error, 'The request failed.'),
      uncertain: error.code === 'ZodError',
    };
  }
  return {
    kind: 'other',
    message: failureText(error, 'The request failed.'),
    uncertain: true,
  };
}
