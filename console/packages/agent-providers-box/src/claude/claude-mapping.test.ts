import type { SDKAssistantMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import {
  approvalContent,
  isUsageLimitText,
  mcpToolParts,
  rateLimitErrorText,
  rejectedLimit,
  resultHitUsageLimit,
  usageLimitNotice,
} from './claude-mapping';

function assistant(text: string, error?: SDKAssistantMessage['error']): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    ...(error ? { error } : {}),
  } as unknown as SDKAssistantMessage;
}

function result(fields: Record<string, unknown>): SDKResultMessage {
  return { type: 'result', subtype: 'success', is_error: false, result: '', ...fields } as never;
}

const THROTTLE =
  'API Error: 429 {"type":"rate_limit_error","message":"Number of requests exceeded"}';

describe('usage limit detection', () => {
  it('recognises the CLI’s own limit wording and nothing else', () => {
    expect(isUsageLimitText("You've hit your 5-hour limit · resets 8:40am")).toBe(true);
    expect(isUsageLimitText("  You've reached your weekly limit")).toBe(true);
    expect(isUsageLimitText('The build hit a limit')).toBe(false);
    expect(isUsageLimitText(THROTTLE)).toBe(false);
  });

  it('takes the notice only from a flagged assistant message in the usage-limit wording', () => {
    expect(
      usageLimitNotice(assistant("You've hit your 5-hour limit · resets 8:40am", 'rate_limit'))
    ).toBe("You've hit your 5-hour limit · resets 8:40am");
    expect(usageLimitNotice(assistant("You're out of usage credits", 'billing_error'))).toBe(
      "You're out of usage credits"
    );
    expect(usageLimitNotice(assistant(THROTTLE, 'rate_limit'))).toBeUndefined();
    expect(usageLimitNotice(assistant('Invalid API key', 'authentication_failed'))).toBeUndefined();
    expect(usageLimitNotice(assistant("You've hit your 5-hour limit"))).toBeUndefined();
  });

  it('keeps the text of a rate_limit message apart, whatever it says', () => {
    expect(rateLimitErrorText(assistant(THROTTLE, 'rate_limit'))).toBe(THROTTLE);
    expect(rateLimitErrorText(assistant(THROTTLE, 'server_error'))).toBeUndefined();
    expect(rateLimitErrorText(assistant(THROTTLE))).toBeUndefined();
  });

  it('reads a limit off a result only when the result is an error', () => {
    expect(
      resultHitUsageLimit(result({ is_error: true, result: "You've hit your limit" }), false)
    ).toBe(true);
    expect(resultHitUsageLimit(result({ result: "You've hit your limit" }), false)).toBe(false);
    expect(
      resultHitUsageLimit(
        result({ subtype: 'error_during_execution', errors: ["You've hit your 5-hour limit"] }),
        false
      )
    ).toBe(true);
    expect(
      resultHitUsageLimit(result({ subtype: 'error_during_execution', errors: ['boom'] }), false)
    ).toBe(false);
  });

  it('takes a 429 for the usage limit only beside its wording or a rejected limit', () => {
    const throttled = result({ is_error: true, api_error_status: 429, result: THROTTLE });
    expect(resultHitUsageLimit(throttled, false)).toBe(false);
    expect(resultHitUsageLimit(throttled, true)).toBe(true);
    expect(
      resultHitUsageLimit(
        result({ is_error: true, api_error_status: 429, result: "You've hit your 5-hour limit" }),
        false
      )
    ).toBe(true);
  });

  it('gives a rejected limit, and its reset time in epoch ms, and none otherwise', () => {
    expect(rejectedLimit({ status: 'rejected', resetsAt: 1_800_000_000 })).toEqual({
      resetsAt: 1_800_000_000_000,
    });
    expect(rejectedLimit({ status: 'rejected' })).toEqual({ resetsAt: null });
    expect(
      rejectedLimit({ status: 'rejected', resetsAt: 1_800_000_000, isUsingOverage: true })
    ).toBeNull();
    expect(rejectedLimit({ status: 'allowed_warning', resetsAt: 1_800_000_000 })).toBeNull();
  });
});

describe('mcpToolParts', () => {
  it('splits a tool name into its server and tool', () => {
    expect(mcpToolParts('mcp__atlassian__addCommentToJiraIssue')).toEqual({
      server: 'atlassian',
      tool: 'addCommentToJiraIssue',
    });
    expect(mcpToolParts('mcp__google_workspace__docs_get')).toEqual({
      server: 'google_workspace',
      tool: 'docs_get',
    });
  });

  it('finds nothing in a name that is not an MCP tool', () => {
    expect(mcpToolParts('Bash')).toBeUndefined();
    expect(mcpToolParts('mcp__atlassian')).toBeUndefined();
    expect(mcpToolParts('mcp__atlassian__')).toBeUndefined();
  });
});

describe('approvalContent for an MCP tool', () => {
  it('names the server and tool and shows the input', () => {
    expect(
      approvalContent(
        'mcp__atlassian__addCommentToJiraIssue',
        { issueIdOrKey: 'PROJ-1', commentBody: 'Shipped in 1.2.' },
        'Claude wants to use addCommentToJiraIssue',
        undefined
      )
    ).toEqual({
      title: 'atlassian wants to run addCommentToJiraIssue',
      detail: '{"issueIdOrKey":"PROJ-1","commentBody":"Shipped in 1.2."}',
    });
  });

  it('leaves the detail out when there is no input', () => {
    expect(approvalContent('mcp__datadog__list_monitors', {}, undefined, undefined)).toEqual({
      title: 'datadog wants to run list_monitors',
    });
  });

  it('keeps a description the SDK sends, in the title', () => {
    expect(
      approvalContent('mcp__datadog__list_monitors', {}, undefined, 'Lists every monitor')
    ).toEqual({ title: 'datadog wants to run list_monitors — Lists every monitor' });
  });

  it('shows a long comment in full up to the limit, and says what it cut', () => {
    const readable = 'a'.repeat(900);
    const shown = approvalContent(
      'mcp__atlassian__addComment',
      { body: readable },
      undefined,
      undefined
    );
    expect(shown.detail).toBe(JSON.stringify({ body: readable }));

    const long = 'b'.repeat(1200);
    const cut = approvalContent('mcp__atlassian__addComment', { body: long }, undefined, undefined);
    const json = JSON.stringify({ body: long });
    expect(cut.detail).toBe(
      `${json.slice(0, 1000)}… (${json.length - 1000} more characters not shown)`
    );
  });
});
