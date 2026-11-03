import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import {
  forkSession as sdkForkSession,
  listSessions as sdkListSessions,
  type SessionStore,
  type SessionStoreEntry,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/** The Claude Code conversations started in a folder outside Switch, newest first. */
export const cliConversationListSchema = z.object({
  /**
   * Whether every running Claude Code process said which conversation it has
   * open. False when this Claude Code keeps no such records, or a live
   * process's record could not be read: an open conversation can then look
   * like a closed one.
   */
  ownershipKnown: z.boolean(),
  conversations: z.array(
    z.object({
      nativeSessionId: z.string(),
      title: z.string(),
      lastActivityAt: z.number(),
      gitBranch: z.string().nullable(),
      /** The running Claude Code process that has the conversation open, or null for none. */
      openIn: z.object({ pid: z.number(), entrypoint: z.string().nullable() }).nullable(),
    })
  ),
});
export type CliConversationList = z.infer<typeof cliConversationListSchema>;

export const forkedCliConversationSchema = z.object({ nativeSessionId: z.string() });

/** What a fork is titled in Claude Code's own `/resume` list, so it reads as taken. */
const FORK_TITLE_SUFFIX = ' (continued in Switch Console)';

/**
 * One running Claude Code process's own record, `sessions/<pid>.json` under its
 * config directory. Only the conversation it names is required; the rest is
 * read where it is in a shape this knows.
 */
const holderRecordSchema = z.object({
  sessionId: z.string().min(1),
  procStart: z.unknown().optional(),
  entrypoint: z.unknown().optional(),
});

/**
 * A command line that runs Claude Code: its `claude` executable, or the npm or
 * SDK package's script. Not any mention of the word, which a shell running a
 * script about `~/.claude` would make.
 */
const CLAUDE_COMMAND =
  /(?:^|[/\\\s])claude(?:\.exe)?(?:\s|$)|@anthropic-ai\/claude-(?:code|agent-sdk)\//;

/** How far apart a record's start time and its process's may be and still be the same process. */
const START_TOLERANCE_MS = 5_000;

type Holder = { pid: number; entrypoint: string | null };
type HolderRecord = z.infer<typeof holderRecordSchema>;

/** A running process as `ps` describes it. */
export type ProcessInfo = { startedAt: number | null; command: string };

export interface CliConversationDeps {
  listSessions: typeof sdkListSessions;
  forkSession: typeof sdkForkSession;
  processExists: (pid: number) => boolean;
  /** What `ps` says about these processes, in one call; null when it cannot be asked. */
  processes: (pids: number[]) => Promise<Map<number, ProcessInfo> | null>;
}

const defaultDeps: CliConversationDeps = {
  listSessions: sdkListSessions,
  forkSession: sdkForkSession,
  processExists,
  processes,
};

/**
 * The conversations started in `dir` from Claude Code's own terminal or IDE
 * clients, with the process that has each one open. Conversations a program
 * started through the SDK, Switch's own sessions among them, are left out, and
 * so are the copies Switch made to continue: one whose session went away, or
 * whose copy finished after Console stopped waiting, is not a CLI conversation.
 *
 * `env` is the session's execution environment, so the conversations are
 * looked for in the config directory the session's Claude Code will use.
 */
export async function listClaudeCliConversations(
  dir: string,
  env: Record<string, string | undefined>,
  deps: CliConversationDeps = defaultDeps
): Promise<CliConversationList> {
  const [sessions, ownership] = await Promise.all([
    withClaudeConfigDir(env, () =>
      deps.listSessions({ dir, includeProgrammatic: false, includeWorktrees: false })
    ),
    claudeHolders(claudeConfigDir(env), deps),
  ]);
  return {
    ownershipKnown: ownership !== null && ownership.complete,
    conversations: sessions
      .filter((session) => !session.summary.endsWith(FORK_TITLE_SUFFIX))
      .sort((a, b) => b.lastModified - a.lastModified)
      .map((session) => ({
        nativeSessionId: session.sessionId,
        title: session.summary,
        lastActivityAt: session.lastModified,
        gitBranch: session.gitBranch ?? null,
        openIn: ownership?.holders.get(session.sessionId) ?? null,
      })),
  };
}

/**
 * A copy of a Claude Code conversation under a new id, for a Switch session to
 * continue: the original stays the terminal's, and nothing Switch does is
 * written to it. Refused while a running Claude Code process has it open, so
 * the copy is never taken from the middle of a turn; and, where Claude Code
 * cannot say which conversations are open, unless the person said this one
 * is closed (`confirmedClosed`).
 */
export async function forkClaudeCliConversation(
  dir: string,
  nativeSessionId: string,
  confirmedClosed: boolean,
  env: Record<string, string | undefined>,
  deps: CliConversationDeps = defaultDeps
): Promise<{ nativeSessionId: string }> {
  const ownership = await claudeHolders(claudeConfigDir(env), deps);
  const holder = ownership?.holders.get(nativeSessionId);
  if (holder)
    throw new Error(
      `This conversation is open in Claude Code (process ${holder.pid}). Close it there, then try again.`
    );
  if ((ownership === null || !ownership.complete) && !confirmedClosed)
    throw new Error(
      'Console cannot tell whether this conversation is open in Claude Code right now. Choose it again and confirm it is closed.'
    );
  return withClaudeConfigDir(env, async () => {
    const listed = await deps.listSessions({
      dir,
      includeProgrammatic: false,
      includeWorktrees: false,
    });
    const source = listed.find((session) => session.sessionId === nativeSessionId);
    if (!source)
      throw new Error(`Claude Code has no conversation ${nativeSessionId} in ${dir} to continue.`);
    const fork = await deps.forkSession(nativeSessionId, {
      dir,
      title: `${source.summary.slice(0, 200)}${FORK_TITLE_SUFFIX}`,
    });
    return { nativeSessionId: fork.sessionId };
  });
}

/**
 * The saved conversations under one Claude Code config directory, as the SDK's
 * readers take a store: for reading a conversation from the directory a
 * session uses without changing this process's environment, which a host
 * running other work cannot afford. Read only; a conversation is found by its
 * id under any project, as Claude Code's own resume finds it.
 */
export function configDirSessionStore(configDir: string): SessionStore {
  return {
    append: async () => {
      throw new Error('This store only reads saved conversations.');
    },
    load: async ({ sessionId, subpath }) => {
      if (subpath !== undefined) return null;
      const projects = join(configDir, 'projects');
      let names: string[];
      try {
        names = await readdir(projects);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      for (const name of names) {
        let text: string;
        try {
          text = await readFile(join(projects, name, `${sessionId}.jsonl`), 'utf8');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'ENOTDIR') continue;
          throw error;
        }
        // A line cut short by a write in progress is the only one left out.
        return text.split('\n').flatMap((line): SessionStoreEntry[] => {
          if (!line.trim()) return [];
          try {
            return [JSON.parse(line) as SessionStoreEntry];
          } catch {
            return [];
          }
        });
      }
      return null;
    },
  };
}

/** Where Claude Code keeps its conversations for a process with this environment. */
export function claudeConfigDir(env: Record<string, string | undefined>): string {
  return env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude');
}

/** The last `withClaudeConfigDir` call to settle; each waits for the one before. */
let configDirTurn: Promise<unknown> = Promise.resolve();

/**
 * Runs `work` with this process's `CLAUDE_CONFIG_DIR` naming the directory
 * `env` gives Claude Code. Listing and copying use the SDK's own file access,
 * which takes the directory from this process's environment and remembers it
 * per value of the variable, so setting it is enough. For the host's one-off
 * commands, each its own short-lived process; a long-lived host reads through
 * {@link configDirSessionStore} instead. Calls take turns all the same, and
 * are not to be nested: an inner call would wait for the outer one for ever.
 */
export function withClaudeConfigDir<T>(
  env: Record<string, string | undefined>,
  work: () => Promise<T>
): Promise<T> {
  const run = configDirTurn.then(async () => {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir(env);
    try {
      return await work();
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });
  configDirTurn = run.catch(() => {});
  return run;
}

/**
 * The conversations Claude Code's running processes have open, by
 * conversation id, from the record each process keeps. Null when there are no
 * records at all: a Claude Code too old to keep them.
 *
 * Wrong in the safe direction where it has to be. A record whose process has
 * gone holds nothing, and neither does one whose process id now names
 * something other than Claude Code that started at another time. A live
 * process that is Claude Code holds its conversation whatever its start time
 * says, since a clock that was stepped moves that; so does one `ps` cannot
 * describe. A live process whose record cannot be read leaves `complete` false.
 */
async function claudeHolders(
  dir: string,
  deps: CliConversationDeps
): Promise<{ holders: Map<string, Holder>; complete: boolean } | null> {
  let names: string[];
  try {
    names = await readdir(join(dir, 'sessions'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const records: { pid: number; record: HolderRecord | null }[] = [];
  for (const name of names) {
    const pid = Number(/^(\d+)\.json$/.exec(name)?.[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !deps.processExists(pid)) continue;
    const record = await readHolderRecord(join(dir, 'sessions', name));
    if (record !== 'gone') records.push({ pid, record });
  }
  const described = records.length ? await deps.processes(records.map((r) => r.pid)) : null;
  const holders = new Map<string, Holder>();
  let complete = true;
  for (const { pid, record } of records) {
    const info = described?.get(pid);
    if (info && !CLAUDE_COMMAND.test(info.command)) {
      const recorded = recordedStart(record?.procStart);
      if (
        recorded === null ||
        info.startedAt === null ||
        Math.abs(info.startedAt - recorded) > START_TOLERANCE_MS
      )
        continue;
    }
    if (!record) {
      complete = false;
      continue;
    }
    holders.set(record.sessionId, {
      pid,
      entrypoint: typeof record.entrypoint === 'string' ? record.entrypoint : null,
    });
  }
  return { holders, complete };
}

/**
 * A process record, read twice before giving up: its process rewrites it each
 * time it goes busy or idle, so one read can meet it half written. Null when it
 * cannot be read; `gone` when its process removed it, which it does on exit.
 */
async function readHolderRecord(path: string): Promise<HolderRecord | null | 'gone'> {
  for (let attempt = 0; ; attempt++) {
    try {
      return holderRecordSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'gone';
      if (attempt > 0) {
        console.warn(`Could not read Claude Code's process record ${path}: ${String(error)}`);
        return null;
      }
      await delay(100);
    }
  }
}

/** A record's `procStart`, which Claude Code writes as `ps -o lstart=` prints it in UTC. */
function recordedStart(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(`${value.trim()} UTC`);
  return Number.isNaN(parsed) ? null : parsed;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, as another user's.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * `ps -o pid=,lstart=,args=` for these processes, in UTC and the C locale so its
 * start time reads as Claude Code's records write it. A process that has gone
 * is not in the answer; `ps` then exits 1 if none is left.
 */
async function processes(pids: number[]): Promise<Map<number, ProcessInfo> | null> {
  if (process.platform === 'win32') return null;
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)(
      'ps',
      ['-o', 'pid=,lstart=,args=', '-p', pids.join(',')],
      { encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } }
    ));
  } catch (error) {
    const output = (error as { stdout?: unknown }).stdout;
    if ((error as { code?: unknown }).code !== 1 || typeof output !== 'string') {
      console.warn(
        `Could not ask ps about Claude Code's processes, so each live one is taken to hold its conversation: ${String(error)}`
      );
      return null;
    }
    stdout = output;
  }
  const described = new Map<number, ProcessInfo>();
  for (const line of stdout.split('\n')) {
    const [pid, weekday, month, day, time, year, ...command] = line.trim().split(/\s+/);
    if (!pid || !year) continue;
    const startedAt = Date.parse(`${weekday} ${month} ${day} ${time} ${year} UTC`);
    described.set(Number(pid), {
      startedAt: Number.isNaN(startedAt) ? null : startedAt,
      command: command.join(' '),
    });
  }
  return described;
}
