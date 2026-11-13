import { type ChatFailure, type FailureReader } from '@switch-console/chat-ui/model/failures';
import { describeFailure, failureText } from '@renderer/lib/errors/describe-failure';
import { log } from '@renderer/utils/logger';
import { RpcError } from '@shared/lib/ipc/rpc-error';

const API_CODES: Record<string, ChatFailure['kind']> = {
  NOT_A_MEMBER: 'not-a-member',
  REQUEST_REUSED: 'request-reused',
  MESSAGE_REFUSED: 'refused',
  NOT_A_MANAGER: 'not-a-manager',
  AGENT_OWNER: 'agent-owner',
};

/** What a failed `/chats` call, as main relays it over RPC, means for the chat. */
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

/** An uncoded 404 from an activity route: the server predates live chat activity. */
export function serverTooOld(error: unknown): boolean {
  return (
    error instanceof RpcError &&
    error.code === 'GatewayError' &&
    error.numberField('status') === 404
  );
}

/** How the chat UI reads Console's failures. */
export const consoleFailures: FailureReader = {
  describe: describeFailure,
  chatFailure,
  serverTooOld,
  warn: (message, context) => log.warn(message, context),
};
