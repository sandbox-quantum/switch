import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { asksForCode, deviceCodeIn, linesOf, linksIn, setupTokenIn, terminalText } from './output';

/** The providers whose CLI can sign in through a browser on a machine nobody sits at. */
export const BROWSER_SIGN_IN_PROVIDERS = [
  'claude',
  'codex',
  'cursor',
  'antigravity',
  'opencode',
] as const;
export type BrowserSignInProvider = (typeof BROWSER_SIGN_IN_PROVIDERS)[number];

export function isBrowserSignInProvider(provider: string): provider is BrowserSignInProvider {
  return (BROWSER_SIGN_IN_PROVIDERS as readonly string[]).includes(provider);
}

/** Where the sign-in stands: the page to open, a code to type there, and whether one is pasted back. */
export type SignInPage = { url: string; userCode: string | null; needsCode: boolean };

/** A login a sign-in ended with, as a login given to a machine holds one. */
export type SignedInLogin = { kind: 'setup-token' | 'auth-json'; credential: string };

/**
 * How a sign-in ended: with a login to give the machine, or (Cursor,
 * Antigravity) with the CLI keeping it on the machine itself, where its own
 * sign-in keeps one and where its agents read it, as if signed in there.
 */
export type SignedIn = SignedInLogin | { kind: 'kept-on-machine' };

export type BrowserSignIn = {
  /** The sign-in as the CLI last showed it; null until it printed its page. */
  page: () => SignInPage | null;
  /** Types the code the page showed into the CLI waiting for it. */
  enterCode: (code: string) => void;
  /** Ends the sign-in and everything it started; `done` rejects with `reason`. */
  cancel: (reason: string) => void;
  done: Promise<SignedIn>;
};

/** Variables a CLI could sign in with instead, so only the sign-in under way applies. */
const CLEARED = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'CURSOR_API_KEY',
  'CURSOR_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENCODE_AUTH_CONTENT',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_CONFIG_DIR',
];
/** OpenCode's sign-in with a ChatGPT account by device code, the one it runs without a browser here. */
const OPENCODE_METHOD = 'ChatGPT Pro/Plus (headless)';
/** How long a CLI is given to end once told to, before it is killed: OpenCode ignores SIGTERM. */
const KILL_GRACE_MS = 3_000;
/** Wide enough that Claude Code's TUI never wraps the token or the link. */
const COLUMNS = 1000;
/** How long the CLI is given to exit once it has printed the login. */
const EXIT_GRACE_MS = 5_000;
/** What a code typed in may be: printable, one line. */
const CODE = /^[\x21-\x7e]{1,2048}$/;
/** Most of a CLI's output kept, for the lines a failure shows. */
const OUTPUT_LIMIT = 64 * 1024;

function quoted(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * `claude setup-token` draws a TUI and does nothing without a terminal, so it
 * runs under `script`, which gives it one: util-linux's on Linux, the BSD one
 * on macOS. The BSD one refuses the socket Node hands it as stdin, so there
 * stdin reaches it through `cat`, and the group is ended once `script` is,
 * or `cat` would wait on stdin for ever. The shell's own notice of that is
 * dropped; `script`'s errors are kept.
 */
function underTerminal(command: string): { file: string; args: string[] } {
  const inner = `stty cols ${COLUMNS} rows 50 2>/dev/null; exec ${command}`;
  if (process.platform === 'linux')
    return { file: 'script', args: ['-q', '-e', '-f', '-c', inner, '/dev/null'] };
  if (process.platform === 'darwin')
    return {
      file: '/bin/sh',
      args: [
        '-c',
        `exec 3>&2 2>/dev/null; cat | { script -q /dev/null /bin/sh -c ${quoted(inner)} 2>&3; kill 0; }`,
      ],
    };
  throw new Error(`Signing in through a browser is not supported on ${process.platform}.`);
}

/**
 * Runs the provider's own sign-in on this machine for someone signing in from
 * a browser elsewhere, and resolves with how it ended.
 *
 * - Claude Code: `claude setup-token` prints an authorize link, waits for the
 *   code its page shows to be pasted back, then prints a long-lived token. It
 *   runs with a config folder of its own, so nothing on the machine changes.
 * - Codex: `codex login --device-auth` prints a page and a one-time code to
 *   type there, and writes `auth.json` once the person signs in. It runs with
 *   a `CODEX_HOME` of its own, whose `auth.json` is read and then removed.
 * - OpenCode: `opencode auth login` with ChatGPT's device-code method, the
 *   same page and code as Codex, writes its `auth.json` under an
 *   `XDG_DATA_HOME` of its own, read and then removed.
 * - Cursor: `agent login` prints a page and polls until the person signs in
 *   there, then keeps the login on the machine (the system keychain on macOS,
 *   `~/.config/cursor/auth.json` elsewhere). Its agents read it from there;
 *   Cursor reads no login a machine is given other than an API key.
 * - Antigravity: `agy acp --login` prints a Google page, waits for the code
 *   (or the address) the page ends on to be pasted back, and keeps the login
 *   on the machine (the system keychain, or a file in `~/.gemini` without
 *   one), the only place Google's agy reads a Google sign-in from.
 *
 * Fails with the CLI's last lines when it ends without a login, and kills it
 * on `timeoutMs`, on `signal` and on `cancel`. The login is never logged.
 */
export function startBrowserSignIn(input: {
  provider: BrowserSignInProvider;
  binaryPath: string;
  timeoutMs: number;
  signal: AbortSignal;
  onPage: (page: SignInPage) => void;
}): BrowserSignIn {
  let page: SignInPage | null = null;
  let child: ChildProcess | null = null;
  let entered: string | null = null;
  /** What the CLI printed since the code was typed in; null until then. */
  let sinceCode: string | null = null;
  let stop: (reason: string) => void = () => {};
  let cancelled: string | null = null;
  const done = run();
  // The caller may not be listening yet when it fails early.
  done.catch(() => {});

  async function run(): Promise<SignedIn> {
    const home = await mkdtemp(join(tmpdir(), `switch-${input.provider}-sign-in-`));
    try {
      return await signIn(home);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  function signIn(home: string): Promise<SignedIn> {
    const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color' };
    for (const name of CLEARED) delete env[name];
    const provider = input.provider;
    const claude = provider === 'claude';
    /** Where its login file is written, for the providers whose CLI writes one to read. */
    let loginFile: string | null = null;
    let file = input.binaryPath;
    let args: string[];
    let what: string;
    if (claude) {
      env.CLAUDE_CONFIG_DIR = join(home, '.claude');
      env.SHELL = '/bin/sh';
      ({ file, args } = underTerminal(`${quoted(input.binaryPath)} setup-token`));
      what = 'claude setup-token';
    } else if (provider === 'codex') {
      env.CODEX_HOME = home;
      args = ['login', '--device-auth', '-c', 'cli_auth_credentials_store="file"'];
      what = 'codex login --device-auth';
      loginFile = join(home, 'auth.json');
    } else if (provider === 'opencode') {
      for (const [name, folder] of [
        ['XDG_DATA_HOME', 'data'],
        ['XDG_CONFIG_HOME', 'config'],
        ['XDG_STATE_HOME', 'state'],
        ['XDG_CACHE_HOME', 'cache'],
      ] as const)
        env[name] = join(home, folder);
      args = ['auth', 'login', '--pure', '--provider', 'openai', '--method', OPENCODE_METHOD];
      what = 'opencode auth login';
      loginFile = join(home, 'data', 'opencode', 'auth.json');
    } else if (provider === 'cursor') {
      env.NO_OPEN_BROWSER = '1';
      args = ['login'];
      what = 'agent login';
    } else {
      // The retired Antigravity ACP wrapper signs in to a profile of its own, which agy never reads.
      if (/^(antigravity-acp|agy_acp_server)/i.test(basename(input.binaryPath)))
        return Promise.reject(
          new Error(
            "Signing Antigravity in through a browser needs Google's agy CLI. Install it on the machine and select it in provider setup."
          )
        );
      env.BROWSER = 'false';
      args = ['acp', '--login'];
      what = 'agy acp --login';
    }
    /** Whether it shows a one-time code to type on its page, which is how its page is known. */
    const deviceCode = provider === 'codex' || provider === 'opencode';

    return new Promise<SignedIn>((resolve, reject) => {
      let raw = '';
      let settled = false;
      let token: string | null = null;
      let grace: NodeJS.Timeout | null = null;
      const finish = (outcome: { login: SignedIn } | { error: Error }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (grace) clearTimeout(grace);
        input.signal.removeEventListener('abort', aborted);
        kill();
        if ('login' in outcome) resolve(outcome.login);
        else reject(outcome.error);
      };
      const lastLines = () => {
        const shown = linesOf(terminalText(raw))
          .map((line) => line.trim())
          .filter((line) => line !== '')
          .slice(-6)
          .join('\n');
        return hideCode(shown) || '(it printed nothing)';
      };
      // The code as typed, and as Claude Code echoes it: masked but for its end.
      const hideCode = (text: string) =>
        (entered ? text.replaceAll(entered, '[code]') : text).replace(/\*{3,}\S*/g, '[code]');
      stop = (reason) => finish({ error: new Error(reason) });
      if (cancelled !== null) return stop(cancelled);
      const timer = setTimeout(
        () =>
          finish({
            error: new Error(
              `The sign-in was not finished within ${Math.round(input.timeoutMs / 60_000)} minutes. Start it again.`
            ),
          }),
        input.timeoutMs
      );
      const aborted = () => finish({ error: new Error('The sign-in was stopped.') });
      if (input.signal.aborted) return aborted();
      input.signal.addEventListener('abort', aborted);

      try {
        child = spawn(file, args, {
          cwd: home,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,
        });
      } catch (error) {
        return finish({
          error: new Error(`Could not run ${what}: ${(error as Error).message}`),
        });
      }
      const read = (chunk: Buffer) => {
        raw = (raw + chunk.toString('utf8')).slice(-OUTPUT_LIMIT);
        const text = terminalText(raw);
        const lines = linesOf(text);
        const url = linksIn(lines).find((link) => link.startsWith('https://'));
        const userCode = deviceCode ? deviceCodeIn(lines) : null;
        if (url && (!deviceCode || userCode)) {
          const next = { url, userCode, needsCode: asksForCode(lines) };
          if (
            !page ||
            page.url !== next.url ||
            page.userCode !== next.userCode ||
            page.needsCode !== next.needsCode
          ) {
            page = next;
            input.onPage(next);
          }
        }
        if (sinceCode !== null)
          sinceCode = (sinceCode + chunk.toString('utf8')).slice(-OUTPUT_LIMIT);
        // It says why it refused a code, then waits for Enter to try again.
        const refusal =
          claude && sinceCode !== null
            ? linesOf(terminalText(sinceCode)).find((line) => /\berror\b/i.test(line))
            : undefined;
        if (refusal && !setupTokenIn(text))
          return finish({
            error: new Error(`${what} did not take the code: ${hideCode(refusal.trim())}`),
          });
        if (claude && !token) {
          token = setupTokenIn(text);
          // It may wait for a key before it exits; the token is all it gives.
          if (token) {
            const login = { kind: 'setup-token' as const, credential: token };
            grace = setTimeout(() => finish({ login }), EXIT_GRACE_MS);
          }
        }
      };
      child.stdout?.on('data', read);
      child.stderr?.on('data', read);
      child.stdin?.on('error', () => {});
      child.once('error', (error) =>
        finish({ error: new Error(`Could not run ${what}: ${error.message}`) })
      );
      // `close`, not `exit`: the token can arrive in the last output, after the exit.
      child.once('close', (code, signalName) => {
        child = null;
        if (claude) {
          if (token) return finish({ login: { kind: 'setup-token', credential: token } });
          return finish({
            error: new Error(
              `${what} ended (${signalName ?? `exit ${code}`}) without a token. It printed:\n${lastLines()}`
            ),
          });
        }
        if (code !== 0)
          return finish({
            error: new Error(
              `${what} ended (${signalName ?? `exit ${code}`}) without signing in. It printed:\n${lastLines()}`
            ),
          });
        if (loginFile === null) return finish({ login: { kind: 'kept-on-machine' } });
        readFile(loginFile, 'utf8').then(
          (text) => {
            const credential = text.trim();
            try {
              const parsed: unknown = JSON.parse(credential);
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                throw new Error('it is not a JSON object');
              // It ends without an error when the sign-in failed, having saved nothing.
              if (
                provider === 'opencode' &&
                (parsed as { openai?: { type?: unknown } }).openai?.type !== 'oauth'
              )
                throw new Error('it holds no ChatGPT sign-in');
            } catch (error) {
              return finish({
                error: new Error(
                  `${what} wrote a sign-in file that cannot be used: ${(error as Error).message}`
                ),
              });
            }
            finish({ login: { kind: 'auth-json', credential } });
          },
          (error: Error) =>
            finish({
              error: new Error(`${what} signed in but wrote no sign-in file: ${error.message}`),
            })
        );
      });
    });
  }

  function kill(): void {
    const running = child;
    if (!running) return;
    child = null;
    const signal = (name: NodeJS.Signals) => {
      try {
        if (running.pid !== undefined) process.kill(-running.pid, name);
        else running.kill(name);
      } catch {
        // Already gone.
      }
    };
    signal('SIGTERM');
    setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS).unref();
  }

  return {
    page: () => page,
    enterCode: (code) => {
      const trimmed = code.trim();
      if (!CODE.test(trimmed)) throw new Error('That code cannot be typed in: it is not one line.');
      const stdin = child?.stdin;
      if (!stdin?.writable) throw new Error('The sign-in has already ended. Start it again.');
      entered = trimmed;
      sinceCode = '';
      stdin.write(trimmed);
      // A TUI reads a burst ending in Enter as a paste; Enter on its own submits it.
      // Without a terminal (agy), a line is what is read.
      setTimeout(() => {
        if (stdin.writable) stdin.write(input.provider === 'claude' ? '\r' : '\n');
      }, 300);
    },
    cancel: (reason) => {
      cancelled = reason;
      stop(reason);
    },
    done,
  };
}
