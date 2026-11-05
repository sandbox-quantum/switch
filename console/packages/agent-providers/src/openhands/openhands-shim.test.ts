import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { OPENHANDS_ACP_SHIM } from './openhands-acp';

const python = ['python3', 'python'].find((name) => spawnSync(name, ['--version']).status === 0);

/**
 * The modules the shim patches, in the shape OpenHands CLI 1.16 has them. Its
 * `main` reports what the patched code does, so the shim runs as it does in
 * a session, only on these stand-ins.
 */
const MODULES: Record<string, string> = {
  'acp/__init__.py': 'async def stdio_streams(limit=None, **kwargs):\n    return limit\n',
  'openhands_cli/__init__.py': '',
  'openhands_cli/acp_impl/__init__.py': '',
  'openhands_cli/acp_impl/agent/__init__.py': '',
  'openhands_cli/acp_impl/agent/launcher.py': 'from acp import stdio_streams\n',
  'openhands/__init__.py': '',
  'openhands/sdk/__init__.py': '',
  'openhands/sdk/conversation/__init__.py': '',
  'openhands/sdk/conversation/state.py':
    'class ConversationExecutionStatus:\n    RUNNING = "running"\n    FINISHED = "finished"\n',
  'openhands/sdk/agent/__init__.py': '',
  'openhands/sdk/agent/response_dispatch.py': [
    'class ResponseDispatchMixin:',
    '    def _handle_no_content_response(self, message, llm_response, conversation, state, on_event, *, response_type):',
    '        on_event("nudge")',
    '',
  ].join('\n'),
  'openhands_cli/entrypoint.py': [
    'import asyncio, json, sys',
    'from openhands.sdk.agent.response_dispatch import ResponseDispatchMixin',
    'import openhands_cli.acp_impl.agent.launcher as launcher',
    'class Agent(ResponseDispatchMixin):',
    '    def _emit_message_event(self, message, llm_response, conversation, on_event):',
    '        on_event("message")',
    '    def _maybe_emit_vllm_tokens(self, llm_response, on_event):',
    '        pass',
    'class State:',
    '    execution_status = "running"',
    'def main():',
    '    events, state = [], State()',
    '    Agent()._handle_no_content_response("m", "r", "c", state, events.append, response_type="empty")',
    '    limit = asyncio.run(launcher.stdio_streams())',
    '    print(json.dumps({"argv": sys.argv, "events": events, "status": state.execution_status, "limit": limit}))',
    '    return 0',
    '',
  ].join('\n'),
};

async function run(modules: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'openhands-shim-'));
  for (const [path, source] of Object.entries(modules)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), source);
  }
  // `-I` keeps the working directory off the path in a session; here the
  // stand-ins are put on it instead.
  const code = `import sys\nsys.path.insert(0, ${JSON.stringify(dir)})\n${OPENHANDS_ACP_SHIM}`;
  return spawnSync(python!, ['-I', '-c', code, '--resume', 'abc'], { encoding: 'utf8' });
}

it.skipIf(!python)(
  'ends a turn on a reply with no text instead of telling the model to try again',
  async () => {
    const result = await run(MODULES);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      argv: ['openhands', 'acp', '--resume', 'abc'],
      events: ['message'],
      status: 'finished',
      limit: 50 * 1024 * 1024,
    });
  }
);

it.skipIf(!python)('exits saying so when what it patches is not there', async () => {
  const result = await run({
    ...MODULES,
    'openhands/sdk/agent/response_dispatch.py': 'class ResponseDispatchMixin:\n    pass\n',
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('no longer has _handle_no_content_response');
  expect(result.stdout).toBe('');
});
