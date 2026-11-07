import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, open, realpath, stat } from 'node:fs/promises';
import { basename, delimiter, isAbsolute, resolve, sep } from 'node:path';
import type { AcpLaunch, AcpLaunchInput } from '../acp/hooks';

/**
 * OpenHands 1.16 creates the ACP stdin reader with Python's default 64 KiB
 * limit. Switch's room instructions can be larger than that, so a valid ACP
 * message may never be processed. This integration starts the installed agent
 * with a larger reader using its installed libraries; it does not change the
 * user's installation or replace the agent's protocol implementation.
 *
 * The CLI agent class is an internal OpenHands API. The bootstrap is limited
 * to the version against which it is tested, and unsupported installations
 * fail before a session is sent. The version check is inside the child so it
 * uses the same interpreter and environment as the actual ACP process.
 */
const OPENHANDS_VERSION_CHECK = `
import asyncio
import sys
from importlib.metadata import PackageNotFoundError, version

try:
    from packaging.specifiers import SpecifierSet
    supported = (
        version('openhands') == '1.16.0'
        and version('openhands-sdk') == '1.21.0'
        and version('openhands-tools') == '1.21.0'
        and SpecifierSet('>=0.8.1,<0.9.0').contains(version('agent-client-protocol'))
    )
except (PackageNotFoundError, ImportError, ValueError):
    supported = False
if not supported:
    sys.stderr.write('Switch OpenHands integration requires OpenHands CLI 1.16.0, SDK/tools 1.21.0, and agent-client-protocol >=0.8.1,<0.9.0 in the same Python environment.\\n')
    sys.exit(1)
`;

const OPENHANDS_BOOTSTRAP = `${OPENHANDS_VERSION_CHECK}
# Preserve the CLI entry point's environment and logging initialization.
import openhands_cli.entrypoint
from acp import stdio_streams
from acp.core import AgentSideConnection
from openhands_cli.acp_impl.agent.local_agent import LocalOpenHandsACPAgent

async def serve():
    reader, writer = await stdio_streams(limit=16 * 1024 * 1024)
    AgentSideConnection(
        lambda client: LocalOpenHandsACPAgent(client, 'always-ask', None, False),
        writer,
        reader,
    )
    await asyncio.Event().wait()

asyncio.run(serve())
`;

const UNSUPPORTED_INSTALL =
  'Switch requires a Python-installed OpenHands CLI 1.16.0 with an absolute Python or /usr/bin/env Python shebang; standalone executables and other launcher formats are not supported by this integration.';

/** Look up the executable in the child process's cwd and PATH, not our own. */
async function resolveOpenHands(binaryPath: string, cwd: string, path: string | undefined) {
  const candidates =
    isAbsolute(binaryPath) || binaryPath.includes(sep)
      ? [resolve(cwd, binaryPath)]
      : (path ?? '/usr/bin:/bin')
          .split(delimiter)
          .map((directory) => resolve(cwd, directory || '.', binaryPath));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Try the next PATH entry, just as process spawning would.
    }
  }
  throw new Error('OpenHands CLI was not found on the execution machine.');
}

/** Select the interpreter belonging to this exact Python console script. */
async function openhandsPython(
  executable: string,
  cwd: string,
  path: string | undefined
): Promise<string> {
  const file = await open(executable, 'r');
  try {
    if (!(await file.stat()).isFile()) throw new Error(UNSUPPORTED_INSTALL);
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const contents = buffer.subarray(0, bytesRead).toString('utf8');
    const firstLine = contents.split('\n', 1)[0]?.replace(/\r$/, '') ?? '';
    const match = /^#!\s*(\/[^\s]+)\s*$/.exec(firstLine);
    const envMatch = /^#!\/usr\/bin\/env (python(?:\d+(?:\.\d+)?)?)$/.exec(firstLine);
    let interpreter = match?.[1];
    if (envMatch) {
      // Match env's PATH lookup exactly, including empty/relative entries. Do
      // not resolve interpreter symlinks: their venv location is significant.
      await access('/usr/bin/env', constants.X_OK).catch(() => {
        throw new Error(UNSUPPORTED_INSTALL);
      });
      for (const directory of (path ?? '/usr/bin:/bin').split(delimiter)) {
        const candidate = resolve(cwd, directory || '.', envMatch[1]!);
        try {
          await access(candidate, constants.X_OK);
          if ((await stat(candidate)).isFile()) {
            interpreter = candidate;
            break;
          }
        } catch {
          // Continue PATH search without falling back to an unrelated Python.
        }
      }
    }
    if (
      !interpreter ||
      !/^python(?:\d+(?:\.\d+)?)?$/.test(basename(interpreter)) ||
      !/^from openhands_cli\.entrypoint import main\s*$/m.test(contents)
    )
      throw new Error(UNSUPPORTED_INSTALL);
    await access(interpreter, constants.X_OK).catch(() => {
      throw new Error(UNSUPPORTED_INSTALL);
    });
    return interpreter;
  } finally {
    await file.close();
  }
}

/** Launch the installed OpenHands agent with a reader large enough for ACP. */
export async function launchOpenHands(input: AcpLaunchInput): Promise<AcpLaunch> {
  if (process.platform === 'win32') throw new Error(UNSUPPORTED_INSTALL);
  const executable = await resolveOpenHands(input.binaryPath, input.cwd, input.env.PATH);
  const interpreter = await openhandsPython(executable, input.cwd, input.env.PATH);
  return { command: interpreter, args: ['-u', '-c', OPENHANDS_BOOTSTRAP], env: input.env };
}

/** Check launch layout and package versions without starting an agent or signing in. */
export async function preflightOpenHands(input: AcpLaunchInput): Promise<void> {
  const launch = await launchOpenHands(input);
  await new Promise<void>((resolve, reject) => {
    execFile(
      launch.command,
      ['-c', OPENHANDS_VERSION_CHECK],
      { cwd: input.cwd, env: launch.env, timeout: 10_000, maxBuffer: 16 * 1024 },
      (error) => {
        if (error) {
          // Child errors/output may contain environment values; use a fixed diagnostic.
          reject(
            new Error(
              'OpenHands package compatibility check failed. Switch requires OpenHands CLI 1.16.0, SDK/tools 1.21.0, and agent-client-protocol >=0.8.1,<0.9.0 in the same Python environment.'
            )
          );
        } else resolve();
      }
    );
  });
}
