/** Long enough to read the text of a comment, which is often the thing being approved. */
const INPUT_DETAIL_LIMIT = 1000;

/**
 * The approval card for an MCP server's tool: the server and tool in the
 * title, as Codex words it, and the input as the detail, since the input is
 * what will run. No detail when the tool takes no input.
 */
export function mcpApprovalContent(
  server: string,
  tool: string,
  input: Record<string, unknown>
): { title: string; detail?: string } {
  const detail = toolInputDetail(input);
  return { title: `${server} wants to run ${tool}`, ...(detail ? { detail } : {}) };
}

/**
 * A tool's input as compact JSON; undefined when there is none. Past the limit
 * it is cut, and the cut says how much it left out, so nobody approves text
 * they believe they read in full.
 */
export function toolInputDetail(input: Record<string, unknown>): string | undefined {
  if (Object.keys(input).length === 0) return undefined;
  const json = JSON.stringify(input);
  if (json.length <= INPUT_DETAIL_LIMIT) return json;
  const omitted = json.length - INPUT_DETAIL_LIMIT;
  return `${json.slice(0, INPUT_DETAIL_LIMIT)}… (${omitted} more characters not shown)`;
}
