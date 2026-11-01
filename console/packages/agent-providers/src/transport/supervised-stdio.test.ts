import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SupervisedStdioTransport } from './supervised-stdio';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const echoServerPath = join(__dirname, '../testing/fixtures/echo-mcp-server.mjs');

describe('SupervisedStdioTransport', () => {
  let transport: SupervisedStdioTransport | null = null;
  let client: Client | null = null;

  afterEach(async () => {
    if (client) {
      await client.close().catch(() => {});
      client = null;
    }
    if (transport) {
      await transport.close();
      transport = null;
    }
  });

  it('performs protocol handshake and tool call against echo-mcp-server fixture', async () => {
    transport = new SupervisedStdioTransport({
      command: process.execPath,
      args: [echoServerPath],
      cwd: process.cwd(),
      env: {},
    });

    client = new Client({ name: 'switch-test-client', version: '1.0.0' });
    await client.connect(transport);

    // 1. Tool discovery
    const toolList = await client.listTools();
    expect(toolList.tools).toBeDefined();
    expect(toolList.tools.some((t) => t.name === 'switch_echo')).toBe(true);

    // 2. Tool execution
    const result = await client.callTool({
      name: 'switch_echo',
      arguments: { text: 'Hello Switch MCP!' },
    });

    expect(result.content).toBeDefined();
    expect(result.content).toEqual([{ type: 'text', text: 'Hello Switch MCP!' }]);
  });

  it('handles multi-message chunks and CRLF framing cleanly', async () => {
    const receivedMessages: unknown[] = [];
    let closeFired = false;

    // A mock child script that outputs multiple frames in a single chunk with \r\n line endings
    const mockScript = `
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', method: 'notify1', params: { a: 1 } }) + '\\r\\n' +
        JSON.stringify({ jsonrpc: '2.0', method: 'notify2', params: { b: 2 } }) + '\\r\\n'
      );
      setInterval(() => {}, 1000);
    `;

    transport = new SupervisedStdioTransport({
      command: process.execPath,
      args: ['-e', mockScript],
      cwd: process.cwd(),
      env: {},
    });

    transport.onmessage = (msg) => {
      receivedMessages.push(msg);
    };
    transport.onclose = () => {
      closeFired = true;
    };

    await transport.start();

    // Wait briefly for stdout chunks to be processed
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(receivedMessages).toHaveLength(2);
    expect(receivedMessages[0]).toEqual({ jsonrpc: '2.0', method: 'notify1', params: { a: 1 } });
    expect(receivedMessages[1]).toEqual({ jsonrpc: '2.0', method: 'notify2', params: { b: 2 } });

    await transport.close();
    expect(closeFired).toBe(true);
  });

  it('correctly stitches multi-byte UTF-8 sequences split across arbitrary chunks', async () => {
    const receivedMessages: unknown[] = [];

    // Script emits a 3-byte UTF-8 character (e.g. '€' = 0xE2, 0x82, 0xAC) across 2 chunks
    const mockScript = `
      const b1 = Buffer.from('{"jsonrpc":"2.0","method":"utf8Test","params":{"char":"');
      const euro = Buffer.from('€', 'utf8'); // 3 bytes: e2 82 ac
      const euroPart1 = euro.subarray(0, 1);
      const euroPart2 = euro.subarray(1);
      const b2 = Buffer.from('"}}\\n');

      process.stdout.write(Buffer.concat([b1, euroPart1]));
      setTimeout(() => {
        process.stdout.write(Buffer.concat([euroPart2, b2]));
      }, 50);
      setInterval(() => {}, 1000);
    `;

    transport = new SupervisedStdioTransport({
      command: process.execPath,
      args: ['-e', mockScript],
      cwd: process.cwd(),
      env: {},
    });

    transport.onmessage = (msg) => {
      receivedMessages.push(msg);
    };

    await transport.start();

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(receivedMessages).toHaveLength(1);
    expect(receivedMessages[0]).toEqual({
      jsonrpc: '2.0',
      method: 'utf8Test',
      params: { char: '€' },
    });
  });

  it('enforces maximum frame limit on oversized individual line', async () => {
    let capturedError: Error | null = null;
    let closed = false;

    // Small 1 KiB max frame limit for test
    transport = new SupervisedStdioTransport({
      command: process.execPath,
      args: ['-e', "process.stdout.write('A'.repeat(2048) + '\\n'); setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      env: {},
      maxFrameBytes: 1024,
    });

    transport.onerror = (err) => {
      capturedError = err;
    };
    transport.onclose = () => {
      closed = true;
    };

    await transport.start();

    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(capturedError).toBeDefined();
    expect((capturedError as unknown as Error)?.message).toContain('FRAME_OVERFLOW_ERROR');
    expect(closed).toBe(true);
  });

  it('rejects send() after close() deterministically', async () => {
    transport = new SupervisedStdioTransport({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwd: process.cwd(),
      env: {},
    });

    await transport.start();
    await transport.close();

    await expect(
      transport.send({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} })
    ).rejects.toThrow('Transport is closed; send rejected');
  });
});
