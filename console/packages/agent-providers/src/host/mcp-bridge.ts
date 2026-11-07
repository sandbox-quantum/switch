import { runOpenHandsMcpBridge } from '../openhands/mcp-bridge';

/** Run the selected provider's MCP compatibility bridge in the host process. */
export async function runMcpBridge(provider: string | undefined): Promise<void> {
  switch (provider) {
    case 'openhands':
      await runOpenHandsMcpBridge();
      return;
    default:
      throw new Error('Unsupported MCP bridge provider.');
  }
}
