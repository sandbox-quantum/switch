import type { AcpToolCall } from '../acp/protocol';

/**
 * Droid's ACP Task call is `kind: other` and has no identifying metadata at
 * first. Its native input has these three fields; a later update may carry
 * `subagent_session_info`, which is also used by the separate wait tool.
 * Require the Task input rather than classifying every wait as a subagent.
 */
export function isDroidSubagent(toolCall: AcpToolCall): boolean {
  const input = toolCall.rawInput;
  const factory = toolCall._meta?.factory as { source?: unknown } | undefined;
  return (
    toolCall.kind === 'other' &&
    factory?.source !== 'mcp' &&
    !toolCall.toolCallId.startsWith('mcp_') &&
    typeof input?.subagent_type === 'string' &&
    typeof input.description === 'string' &&
    typeof input.prompt === 'string'
  );
}
