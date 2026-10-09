import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  serveMcpOverHttp,
  type ToolDefinition,
  type ToolResult,
} from '@sandboxaq/switch-agent-runtime/hosted';
import type { HttpMcpServerSpec } from '../adapter';
import type { Redactions } from './redaction';
import { type CliTool, type ServiceGrant, serviceTokenAnswerSchema } from './service-access';
import type { HostAsk } from './session-channel';
import type { VendorServers } from './vendor-mcp';

/** The most a run may write to its standard output before it is stopped. */
export const CAPTURE_LIMIT_BYTES = 64 * 1024 * 1024;
/** How much of a failed run's standard error is passed on. */
const STDERR_LIMIT_BYTES = 64 * 1024;
const MAX_ARGUMENTS = 200;
const MAX_ARGUMENT_LENGTH = 64 * 1024;

/**
 * The host's own settings a run keeps: how this machine reaches the internet
 * and which certificate authorities it trusts. Nothing of the coding tool's
 * environment reaches a run.
 */
const PASSED_THROUGH = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
];

/** A command the checker refuses, with why, for the coding tool to read. */
export class CommandRefused extends Error {}

type PathArgument = {
  /** Where in the command the path is, and what precedes it there (`--output=`, `-o`, or nothing). */
  index: number;
  prefix: string;
  path: string;
  direction: 'read' | 'write';
};

export type CheckedCommand = { args: string[]; paths: PathArgument[] };

function isLong(flag: string): boolean {
  return flag.startsWith('--');
}

/** `arg` as an occurrence of `flag`: its value written into it, `''` when the value follows, or null. */
function flagValue(arg: string, flag: string): string | null {
  if (arg === flag) return '';
  if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  if (!isLong(flag) && arg.startsWith(flag)) return arg.slice(flag.length);
  return null;
}

/**
 * `args` checked against the tool's catalog entry, without touching the
 * filesystem: the first argument allowed, no denied command or flag, short
 * options never combined (so a path flag cannot hide in a cluster), and every
 * path flag's value found.
 */
export function checkCommand(tool: CliTool, args: unknown): CheckedCommand {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))
    throw new CommandRefused('`args` must be a list of strings, one per argument.');
  const list = args as string[];
  if (list.length === 0)
    throw new CommandRefused(`Give a command: one of ${tool.allow.join(', ')}.`);
  if (list.length > MAX_ARGUMENTS)
    throw new CommandRefused(`A command may have at most ${MAX_ARGUMENTS} arguments.`);
  for (const arg of list) {
    if (arg.length > MAX_ARGUMENT_LENGTH)
      throw new CommandRefused(`An argument may be at most ${MAX_ARGUMENT_LENGTH} characters.`);
    if (arg.includes('\0')) throw new CommandRefused('An argument may not contain a NUL.');
  }
  const [command] = list;
  if (tool.deny.includes(command) || !tool.allow.includes(command))
    throw new CommandRefused(
      `\`${tool.binary} ${command}\` is not available here. The first argument is one of: ${tool.allow.join(', ')}.`
    );
  const deniedFlags = tool.deny.filter((entry) => entry.startsWith('-'));
  const pathFlags = Object.entries(tool.path_flags);
  const paths: PathArgument[] = [];
  for (let index = 1; index < list.length; index += 1) {
    const arg = list[index];
    // A positional file argument follows its word directly, wherever the word
    // stands; held to that, no option can come between them and hide it.
    const positional = tool.path_args.find((path) => path.after === arg);
    if (positional) {
      const next = list[index + 1];
      if (next === undefined || next.startsWith('-'))
        throw new CommandRefused(`\`${arg}\` takes a file path right after it.`);
      paths.push({ index: index + 1, prefix: '', path: next, direction: positional.direction });
      index += 1;
      continue;
    }
    if (!arg.startsWith('-') || arg === '-') continue;
    if (arg === '--') throw new CommandRefused('`--` is not accepted; pass options as options.');
    const denied = deniedFlags.find((flag) => flagValue(arg, flag) !== null);
    if (denied) throw new CommandRefused(`\`${denied}\` is not available here.`);
    const pathFlag = pathFlags.find(([flag]) => flagValue(arg, flag) !== null);
    if (!pathFlag) {
      if (!isLong(arg) && arg.length > 2 && !/^-\d/.test(arg))
        throw new CommandRefused(
          `Short options may not be combined (\`${arg}\`); give each on its own.`
        );
      continue;
    }
    const [flag, direction] = pathFlag;
    const inline = flagValue(arg, flag)!;
    if (inline !== '') {
      paths.push({
        index,
        prefix: arg.slice(0, arg.length - inline.length),
        path: inline,
        direction,
      });
      continue;
    }
    if (arg.endsWith('=') || index + 1 >= list.length)
      throw new CommandRefused(`\`${flag}\` needs a file path.`);
    paths.push({ index: index + 1, prefix: '', path: list[index + 1], direction });
    index += 1;
  }
  return { args: list, paths };
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** A path argument, found inside the session's folder: the file read, or the one to write. */
export type ResolvedPath = PathArgument & { file: string };

/**
 * Each path argument as the file it names, symbolic links resolved, which
 * must be inside the session's folder (`cwd`): a file read must exist; a
 * file written must be in an existing folder there, and be a plain file if
 * it exists. Done before anything is asked for or run.
 */
export async function resolvePaths(checked: CheckedCommand, cwd: string): Promise<ResolvedPath[]> {
  const root = await realpath(cwd);
  const resolved: ResolvedPath[] = [];
  for (const path of checked.paths) {
    const named = resolve(cwd, path.path);
    if (path.direction === 'read') {
      let source: string;
      try {
        source = await realpath(named);
      } catch {
        throw new CommandRefused(`There is no file at \`${path.path}\`.`);
      }
      if (!inside(root, source))
        throw new CommandRefused(`\`${path.path}\` is outside this session's folder.`);
      if (!(await stat(source)).isFile())
        throw new CommandRefused(`\`${path.path}\` is not a file.`);
      resolved.push({ ...path, file: source });
      continue;
    }
    const name = basename(named);
    if (!name || path.path.endsWith('/') || path.path.endsWith(sep))
      throw new CommandRefused(`\`${path.path}\` names a folder, not a file.`);
    let parent: string;
    try {
      parent = await realpath(dirname(named));
    } catch {
      throw new CommandRefused(`The folder for \`${path.path}\` does not exist.`);
    }
    if (!inside(root, parent))
      throw new CommandRefused(`\`${path.path}\` is outside this session's folder.`);
    const target = join(parent, name);
    const existing = await lstat(target).catch(() => null);
    if (existing && !existing.isFile())
      throw new CommandRefused(`\`${path.path}\` exists and is not a plain file.`);
    resolved.push({ ...path, file: target });
  }
  return resolved;
}

type Staged = { args: string[]; moves: { from: string; to: string; named: string }[] };

/**
 * The command with each path argument replaced by a file in the run's own
 * folder (`run`): a file read is copied in from the session's folder; a file
 * written is moved out to it once the run succeeds.
 */
async function stagePaths(args: string[], paths: ResolvedPath[], run: string): Promise<Staged> {
  const staged = [...args];
  const moves: Staged['moves'] = [];
  for (const [n, path] of paths.entries()) {
    const folder = join(run, path.direction === 'read' ? 'in' : 'out', String(n));
    await mkdir(folder, { recursive: true });
    const inRun = join(folder, basename(path.file));
    if (path.direction === 'read') await copyFile(path.file, inRun);
    else moves.push({ from: inRun, to: path.file, named: path.path });
    staged[path.index] = path.prefix + relative(run, inRun);
  }
  return { args: staged, moves };
}

/** Moves a file or folder, across filesystems too. */
async function move(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await cp(from, to, { recursive: true });
    await rm(from, { recursive: true, force: true });
  }
}

/** The run's environment: its token, its folders, and the host's network settings. Nothing else. */
export function runEnvironment(input: {
  tool: CliTool;
  token: string;
  home: string;
  config: string;
  tmp: string;
  hostEnv: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of PASSED_THROUGH) {
    const value = input.hostEnv[name];
    if (value) env[name] = value;
  }
  if (input.platform === 'win32') {
    // Windows' networking and TLS need to find the system.
    const systemRoot = input.hostEnv.SystemRoot ?? input.hostEnv.SYSTEMROOT;
    if (systemRoot) env.SystemRoot = systemRoot;
    env.USERPROFILE = input.home;
    env.TEMP = input.tmp;
    env.TMP = input.tmp;
  }
  env.HOME = input.home;
  env.TMPDIR = input.tmp;
  if (input.tool.config_env) env[input.tool.config_env] = input.config;
  env[input.tool.token_env] = input.token;
  return env;
}

type RunOutcome = {
  code: number | null;
  timedOut: boolean;
  overflowed: boolean;
  stdoutPath: string;
  stdoutBytes: number;
  stderr: string;
};

function runBinary(input: {
  binary: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdoutPath: string;
  timeoutMs: number;
}): Promise<RunOutcome> {
  return new Promise((done, fail) => {
    const child = spawn(input.binary, input.args, {
      cwd: input.cwd,
      env: input.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = createWriteStream(input.stdoutPath, { mode: 0o600 });
    let stdoutBytes = 0;
    let overflowed = false;
    let timedOut = false;
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, input.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > CAPTURE_LIMIT_BYTES) {
        if (!overflowed) child.kill('SIGKILL');
        overflowed = true;
        return;
      }
      out.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= STDERR_LIMIT_BYTES) return;
      stderr.push(chunk.subarray(0, STDERR_LIMIT_BYTES - stderrBytes));
      stderrBytes += chunk.length;
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      out.destroy();
      fail(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      out.end(() =>
        done({
          code,
          timedOut,
          overflowed,
          stdoutPath: input.stdoutPath,
          stdoutBytes: Math.min(stdoutBytes, CAPTURE_LIMIT_BYTES),
          stderr: Buffer.concat(stderr).toString('utf8'),
        })
      );
    });
  });
}

function pathValue(document: unknown, path: string): unknown {
  let value = document;
  for (const part of path.split('.')) {
    if (typeof value !== 'object' || value === null) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** Whether a run ended the way the catalog says a refused token does. */
export function refusedToken(tool: CliTool, code: number | null, stdout: string): boolean {
  if (code !== tool.token_refused.exit_code) return false;
  try {
    return pathValue(JSON.parse(stdout), tool.token_refused.json_path) === tool.token_refused.value;
  } catch {
    return false;
  }
}

/**
 * Each granted vendor command-line tool, served to this session's CLI on
 * loopback as one tool taking `{args}`.
 *
 * The session host runs the vendor's binary itself, never through a shell:
 * each command is checked against the catalog (`checkCommand`), runs in a
 * fresh folder of its own holding an empty `.env` (so the tool reads no
 * settings from the folders around it), and gets an environment of its token,
 * a configuration folder for the session, and the host's network settings.
 * The token is asked for on every run over the pipe, added to this session's
 * redactions, and never reaches the coding tool: not its environment,
 * arguments or files, and not the output, which is redacted. A run that ends
 * as the catalog says a refused token does is run once more on a token asked
 * for again. Output past the catalog's cap is saved to a file in the session's
 * folder (`.switch/<tool>/`, which git ignores), and the path returned.
 */
export async function startVendorClis(input: {
  grants: ServiceGrant[];
  ask: (ask: HostAsk) => Promise<unknown>;
  redactions: Redactions;
  /** The session's working folder. */
  cwd: string;
  /** This session's own folder for the tools' configuration and runs. */
  stateDir: string;
  binary: (tool: CliTool) => Promise<string>;
  hostEnv: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}): Promise<VendorServers> {
  const specs: Record<string, HttpMcpServerSpec> = {};
  const closers: (() => Promise<void>)[] = [];
  try {
    for (const grant of input.grants)
      for (const tool of grant.cli_tools) {
        const runner = new CliRunner(grant.service, tool, input);
        const bearer = randomBytes(32).toString('hex');
        const served = await serveMcpOverHttp(bearer, {
          listTools: async () => [runner.definition()],
          callTool: (name, args) => runner.call(name, args),
        });
        closers.push(served.close);
        specs[tool.name] = {
          transport: 'http',
          url: served.url,
          headers: { Authorization: `Bearer ${bearer}` },
        };
      }
  } catch (error) {
    await Promise.all(closers.map((close) => close()));
    throw error;
  }
  return { specs, close: async () => void (await Promise.all(closers.map((close) => close()))) };
}

class CliRunner {
  private readonly folder: string;

  constructor(
    private readonly service: string,
    private readonly tool: CliTool,
    private readonly deps: {
      ask: (ask: HostAsk) => Promise<unknown>;
      redactions: Redactions;
      cwd: string;
      stateDir: string;
      binary: (tool: CliTool) => Promise<string>;
      hostEnv: NodeJS.ProcessEnv;
      platform: NodeJS.Platform;
    }
  ) {
    this.folder = join(deps.stateDir, tool.name);
  }

  definition(): ToolDefinition {
    const { binary, allow } = this.tool;
    const writes = Object.entries(this.tool.path_flags)
      .filter(([, direction]) => direction === 'write')
      .map(([flag]) => `\`${flag}\``);
    return {
      name: binary,
      description:
        `Runs \`${binary}\`, ${this.service}'s command-line tool, as the agent's owner, with the ` +
        `arguments given, one per item and never through a shell. The first argument is one of: ` +
        `${allow.join(', ')}. Files read or written must be inside the session's folder` +
        (writes.length ? ` (write them with ${writes.join(' or ')})` : '') +
        `. Output longer than ${this.tool.output_cap_bytes} bytes is saved to a file, whose ` +
        `path is returned.`,
      inputSchema: {
        type: 'object',
        properties: {
          args: {
            type: 'array',
            items: { type: 'string' },
            description: `The command line after \`${binary}\`, e.g. ["${allow[0]}", "--help"].`,
          },
        },
        required: ['args'],
        additionalProperties: false,
      },
    };
  }

  async call(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    if (name !== this.tool.binary) throw new Error(`There is no tool ${name} here.`);
    let checked: CheckedCommand;
    let paths: ResolvedPath[];
    try {
      checked = checkCommand(this.tool, input.args);
      paths = await resolvePaths(checked, this.deps.cwd);
    } catch (error) {
      if (error instanceof CommandRefused) return refusal(error.message);
      throw error;
    }
    const binary = await this.deps.binary(this.tool);
    let rejected: string | null = null;
    for (let attempt = 0; ; attempt += 1) {
      const token = await this.token(rejected);
      const result = await this.runOnce(binary, checked.args, paths, token);
      if (result.kind === 'done') return result.result;
      if (attempt > 0)
        return refusal(
          `${this.service} refused this agent's token again after Switch issued a new one.`
        );
      rejected = token;
    }
  }

  private async token(rejected: string | null): Promise<string> {
    const answer = serviceTokenAnswerSchema.parse(
      await this.deps.ask({ type: 'service-token', service: this.service, rejected })
    );
    if (answer.kind === 'refused') throw new Error(answer.message);
    this.deps.redactions.add(answer.token);
    return answer.token;
  }

  private async runOnce(
    binary: string,
    args: string[],
    paths: ResolvedPath[],
    token: string
  ): Promise<{ kind: 'done'; result: ToolResult } | { kind: 'token-refused' }> {
    const home = join(this.folder, 'home');
    const config = join(this.folder, 'config');
    const runs = join(this.folder, 'runs');
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(config, { recursive: true, mode: 0o700 });
    await mkdir(runs, { recursive: true, mode: 0o700 });
    const base = await mkdtemp(join(runs, 'run-'));
    try {
      const run = join(base, 'cwd');
      const tmp = join(base, 'tmp');
      await mkdir(run, { mode: 0o700 });
      await mkdir(tmp, { mode: 0o700 });
      // An empty .env of its own, so the tool loads none from a folder above.
      await writeFile(join(run, '.env'), '', { mode: 0o600 });
      const staged = await stagePaths(args, paths, run);
      const outcome = await runBinary({
        binary,
        args: staged.args,
        cwd: run,
        env: runEnvironment({
          tool: this.tool,
          token,
          home,
          config,
          tmp,
          hostEnv: this.deps.hostEnv,
          platform: this.deps.platform,
        }),
        stdoutPath: join(base, 'stdout'),
        timeoutMs: this.tool.timeout_s * 1000,
      });
      const stdout = await readFile(outcome.stdoutPath, 'utf8');
      if (refusedToken(this.tool, outcome.code, stdout)) return { kind: 'token-refused' };
      return { kind: 'done', result: await this.answer(outcome, stdout, staged, run) };
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }

  private async answer(
    outcome: RunOutcome,
    stdout: string,
    staged: Staged,
    run: string
  ): Promise<ToolResult> {
    const { binary } = this.tool;
    const notes: string[] = [];
    if (outcome.timedOut)
      return refusal(
        `\`${binary}\` did not finish within ${this.tool.timeout_s} s and was stopped.`
      );
    if (outcome.overflowed)
      return refusal(
        `\`${binary}\` wrote more than ${CAPTURE_LIMIT_BYTES} bytes and was stopped. Ask for ` +
          'less, or write the result to a file.'
      );
    for (const { from, to, named } of staged.moves) {
      if (!(await stat(from).catch(() => null))) continue;
      if (outcome.code !== 0) {
        notes.push(`Left ${named} as it was, since the command failed.`);
        continue;
      }
      await move(from, to);
      notes.push(`Wrote ${named}.`);
    }
    for (const saved of await this.keepStrayFiles(run)) notes.push(`Saved ${saved}.`);
    let text = this.deps.redactions.text(stdout);
    if (Buffer.byteLength(text) > this.tool.output_cap_bytes) {
      const saved = await this.saveOutput(text);
      const head = Buffer.from(text).subarray(0, this.tool.output_cap_bytes).toString('utf8');
      text =
        `The output is ${Buffer.byteLength(text)} bytes, more than ${this.tool.output_cap_bytes}; ` +
        `all of it is saved at ${saved}. It begins:\n\n${head}`;
    }
    const failed = outcome.code !== 0;
    const parts = [
      ...(failed ? [`\`${binary}\` exited with code ${outcome.code}.`] : []),
      text,
      ...(failed && outcome.stderr ? [this.deps.redactions.text(outcome.stderr)] : []),
      ...notes,
    ].filter(Boolean);
    return {
      ...(failed ? { isError: true } : {}),
      content: [{ type: 'text', text: parts.join('\n') }],
    };
  }

  /** The session's folder for what this tool saves: inside it, and ignored by git. */
  private async outputFolder(): Promise<string> {
    const folder = join(this.deps.cwd, '.switch', this.tool.name);
    await mkdir(folder, { recursive: true });
    const ignore = join(folder, '.gitignore');
    if (!(await stat(ignore).catch(() => null))) await writeFile(ignore, '*\n');
    return folder;
  }

  private async saveOutput(text: string): Promise<string> {
    const folder = await this.outputFolder();
    const file = join(folder, `output-${Date.now()}-${randomBytes(3).toString('hex')}.txt`);
    await writeFile(file, text);
    return relative(this.deps.cwd, file);
  }

  /** What the run left in its folder unasked, such as a download: moved to the output folder. */
  private async keepStrayFiles(run: string): Promise<string[]> {
    const kept: string[] = [];
    for (const entry of await readdir(run, { withFileTypes: true })) {
      if (['.env', 'in', 'out'].includes(entry.name)) continue;
      const folder = await this.outputFolder();
      const target = join(folder, `${Date.now()}-${entry.name}`);
      await move(join(run, entry.name), target);
      kept.push(relative(this.deps.cwd, target));
    }
    return kept;
  }
}

function refusal(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}
