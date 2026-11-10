import { execFile } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import {
  deleteSession as sdkDeleteSession,
  forkSession as sdkForkSession,
  getSessionInfo as sdkGetSessionInfo,
  listSessions as sdkListSessions,
  type SDKSessionInfo,
  type SessionStore,
  type SessionStoreEntry,
  tagSession as sdkTagSession,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { isProcessAlive } from '../process-alive';

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

/** How many copies `--delete-cli-conversation-copies` removed, for each Console session it named. */
export const deletedCliConversationCopiesSchema = z.object({
  deleted: z.record(z.string(), z.number().int().min(0)),
});

/** What a fork is titled in Claude Code's own `/resume` list, so it reads as taken. */
const FORK_TITLE_SUFFIX = ' (continued in Switch Console)';

/**
 * How every copy Switch makes is tagged: with this and the id of the Console
 * session that owns it. The tag is what a copy left by a session that never
 * started is found and removed by, and it survives a rename where the title
 * would not.
 */
const COPY_TAG_PREFIX = 'switch-console:';

/** The tag of the copy a Console session continues. */
export function cliConversationCopyTag(consoleSessionId: string): string {
  return `${COPY_TAG_PREFIX}${consoleSessionId}`;
}

/**
 * Whether a conversation is a copy Switch made to continue another, by its
 * tag or, for a copy made before copies were tagged, its title.
 */
function isSwitchCopy(session: Pick<SDKSessionInfo, 'tag' | 'summary'>): boolean {
  return (
    session.tag?.startsWith(COPY_TAG_PREFIX) === true || session.summary.endsWith(FORK_TITLE_SUFFIX)
  );
}

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
  getSessionInfo: typeof sdkGetSessionInfo;
  forkSession: typeof sdkForkSession;
  tagSession: typeof sdkTagSession;
  deleteSession: typeof sdkDeleteSession;
  processExists: (pid: number) => boolean;
  /** What `ps` says about these processes, in one call; null when it cannot be asked. */
  processes: (pids: number[]) => Promise<Map<number, ProcessInfo> | null>;
}

const defaultDeps: CliConversationDeps = {
  listSessions: sdkListSessions,
  getSessionInfo: sdkGetSessionInfo,
  forkSession: sdkForkSession,
  tagSession: sdkTagSession,
  deleteSession: sdkDeleteSession,
  processExists: (pid) => isProcessAlive(pid, 'any-user'),
  processes,
};

/**
 * The conversations started in `dir` from Claude Code's own terminal or IDE
 * clients, with the process that has each one open. Conversations a program
 * started through the SDK, Switch's own sessions among them, are left out, and
 * so are the copies Switch made to continue, renamed or not: one whose session
 * went away, or whose copy finished after Console stopped waiting, is not a
 * CLI conversation.
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
      .filter((session) => !isSwitchCopy(session))
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
 * is closed (`confirmedClosed`). A copy Switch made is not copied again.
 *
 * The copy is tagged with the Console session that owns it
 * ({@link cliConversationCopyTag}), so one whose session never started can be
 * found and removed ({@link deleteClaudeCliConversationCopies}). A copy that
 * cannot be tagged is removed at once, since nothing could find it later.
 */
export async function forkClaudeCliConversation(
  request: {
    dir: string;
    nativeSessionId: string;
    consoleSessionId: string;
    confirmedClosed: boolean;
  },
  env: Record<string, string | undefined>,
  deps: CliConversationDeps = defaultDeps
): Promise<{ nativeSessionId: string }> {
  const { dir, nativeSessionId } = request;
  const ownership = await claudeHolders(claudeConfigDir(env), deps);
  const holder = ownership?.holders.get(nativeSessionId);
  if (holder)
    throw new Error(
      `This conversation is open in Claude Code (process ${holder.pid}). Close it there, then try again.`
    );
  if (!request.confirmedClosed) {
    if (ownership === null)
      throw new Error(
        'Console cannot tell whether this conversation is open in Claude Code right now. Choose it again and confirm it is closed.'
      );
    if (!ownership.complete)
      throw new Error(
        'Console could not read which conversations Claude Code has open right now. Try again in a moment.'
      );
  }
  return withClaudeConfigDir(env, async () => {
    const source = await deps.getSessionInfo(nativeSessionId, { dir });
    if (!source)
      throw new Error(`Claude Code has no conversation ${nativeSessionId} in ${dir} to continue.`);
    if (isSwitchCopy(source))
      throw new Error(
        'This conversation is a copy Switch Console made to continue another one. Choose the conversation it was copied from.'
      );
    const fork = await deps.forkSession(nativeSessionId, {
      dir,
      // Cut by code point, so a character outside the BMP is never split in two.
      title: `${Array.from(source.summary).slice(0, 200).join('')}${FORK_TITLE_SUFFIX}`,
    });
    try {
      await deps.tagSession(fork.sessionId, cliConversationCopyTag(request.consoleSessionId), {
        dir,
      });
    } catch (error) {
      try {
        await deps.deleteSession(fork.sessionId, { dir });
      } catch (removal) {
        throw new Error(
          `Could not mark the copy ${fork.sessionId} of this conversation as Switch Console's (${String(error)}), nor remove it (${String(removal)}).`,
          { cause: error }
        );
      }
      throw new Error(
        `Could not mark the copy of this conversation as Switch Console's, so it was removed: ${String(error)}`,
        { cause: error }
      );
    }
    return { nativeSessionId: fork.sessionId };
  });
}

/**
 * Removes the copies in `dir` tagged as any of the given Console sessions',
 * and says how many each had: what is left when a session's copy was made but
 * the session never started. Only a conversation carrying exactly one of those
 * sessions' tags is removed. The folder is listed once for all of them.
 */
export async function deleteClaudeCliConversationCopies(
  dir: string,
  consoleSessionIds: string[],
  env: Record<string, string | undefined>,
  deps: CliConversationDeps = defaultDeps
): Promise<{ deleted: Record<string, number> }> {
  const owners = new Map(consoleSessionIds.map((id) => [cliConversationCopyTag(id), id]));
  return withClaudeConfigDir(env, async () => {
    const deleted: Record<string, number> = Object.fromEntries(
      consoleSessionIds.map((id) => [id, 0])
    );
    const sessions = await deps.listSessions({
      dir,
      includeProgrammatic: true,
      includeWorktrees: false,
    });
    for (const session of sessions) {
      const owner = session.tag === undefined ? undefined : owners.get(session.tag);
      if (owner === undefined) continue;
      await deps.deleteSession(session.sessionId, { dir });
      deleted[owner] = (deleted[owner] ?? 0) + 1;
    }
    return { deleted };
  });
}

/**
 * The saved conversations under one Claude Code config directory, as the SDK's
 * readers take a store: for reading a conversation from the directory a
 * session uses without changing this process's environment, which a host
 * running other work cannot afford. Read only; a conversation is found by its
 * id under any project, as Claude Code's own resume finds it.
 *
 * Only a last line that is not JSON is left out: a write Claude Code has not
 * finished. Anywhere else such a line is a transcript this cannot read whole,
 * and reading it is refused rather than shown with a gap.
 */
export function configDirSessionStore(configDir: string): SessionStore {
  return {
    append: async () => {
      throw new Error('This store only reads saved conversations.');
    },
    load: async ({ sessionId, subpath }) => {
      if (subpath !== undefined) return null;
      const path = await savedConversationPath(configDir, sessionId);
      if (path === null) return null;
      const lines = (await readFile(path, 'utf8')).split('\n');
      let last = lines.length - 1;
      while (last >= 0 && !lines[last]!.trim()) last--;
      return lines.flatMap((line, index): SessionStoreEntry[] => {
        if (!line.trim()) return [];
        try {
          return [JSON.parse(line) as SessionStoreEntry];
        } catch (error) {
          if (index === last) return [];
          throw new Error(
            `Line ${index + 1} of Claude Code's saved conversation ${path} is not JSON: ${String(error)}`,
            { cause: error }
          );
        }
      });
    },
  };
}

/**
 * Where Claude Code saved the conversation with this id under a config
 * directory, `projects/<directory>/<id>.jsonl` in whichever project it was
 * started in; null when it saved none.
 */
export async function savedConversationPath(
  configDir: string,
  sessionId: string
): Promise<string | null> {
  const projects = join(configDir, 'projects');
  let names: string[];
  try {
    names = await readdir(projects);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  for (const name of names) {
    const path = join(projects, name, `${sessionId}.jsonl`);
    try {
      await access(path);
      return path;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
  }
  return null;
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
