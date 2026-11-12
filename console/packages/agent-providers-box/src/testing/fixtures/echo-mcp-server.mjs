#!/usr/bin/env node
// Minimal stdio MCP server with one tool, `switch_echo`, for conformance
// tests. Plain JSON-RPC over newline-delimited stdin/stdout, no dependencies.
import { createInterface } from 'node:readline';

const TOOLS = [
  {
    name: 'switch_echo',
    description: 'Echoes the given text back. Used by Switch conformance tests.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
];

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = request;
  if (id === undefined) return;
  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'switch-echo', version: '0.0.1' },
        },
      });
      break;
    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} });
      break;
    case 'tools/list':
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      break;
    case 'tools/call': {
      const text = String(params?.arguments?.text ?? '');
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
      break;
    }
    default:
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method ${method}` } });
  }
});
