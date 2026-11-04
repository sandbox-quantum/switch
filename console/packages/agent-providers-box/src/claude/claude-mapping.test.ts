import { describe, expect, it } from 'vitest';
import { approvalContent, mcpToolParts } from './claude-mapping';

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
