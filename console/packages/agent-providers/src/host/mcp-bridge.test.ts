import { expect, it, vi } from 'vitest';

const runOpenHandsMcpBridge = vi.fn(async () => {});
vi.mock('../openhands/mcp-bridge', () => ({ runOpenHandsMcpBridge }));
const { runMcpBridge } = await import('./mcp-bridge');

it('dispatches the selected provider compatibility bridge', async () => {
  await runMcpBridge('openhands');
  expect(runOpenHandsMcpBridge).toHaveBeenCalledOnce();
});

it.each([undefined, '', 'other'])('rejects an unsupported bridge provider', async (provider) => {
  await expect(runMcpBridge(provider)).rejects.toThrow('Unsupported MCP bridge provider.');
});
