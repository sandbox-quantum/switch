import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type BrowserSignInProvider, type SignInPage, startBrowserSignIn } from './browser-sign-in';

const TOKEN = `sk-ant-oat01-${'a'.repeat(40)}AA`;

/** Stands in for `claude setup-token`: a link, a prompt, and a token once a code is typed. */
const FAKE_CLAUDE = `#!/bin/sh
[ -t 0 ] || { echo "not a terminal"; exit 3; }
printf "Browser didn't open? Use the URL below\\n"
printf '\\033]8;id=1;https://claude.ai/oauth/authorize?code=true&x=1\\007https://claude.ai/oauth/authorize?code=true&x=1\\033]8;;\\007\\n'
printf ' Paste code here if prompted > '
read code
[ "$code" = "good#code" ] || { echo "OAuth error: invalid code"; exit 1; }
printf '\\nYour OAuth token (valid for 1 year):\\n\\n${TOKEN}\\n'
`;

/** Stands in for `codex login --device-auth`: a page, a code, then auth.json. */
const FAKE_CODEX = `#!/bin/sh
printf 'Open this link\\n   \\033[94mhttps://auth.openai.com/codex/device\\033[0m\\n'
printf '2. Enter this one-time code\\n   \\033[94mABCD-EFGHI\\033[0m\\n'
[ "$FAKE_CODEX_FAIL" = 1 ] && { echo "Error: device code expired"; exit 1; }
sleep 0.2
printf '{"tokens":{"id_token":"x"}}' > "$CODEX_HOME/auth.json"
`;

/** Stands in for `opencode auth login` with ChatGPT's device code: a page, a code, then auth.json. */
const FAKE_OPENCODE = `#!/bin/sh
[ "$*" = "auth login --pure --provider openai --method ChatGPT Pro/Plus (headless)" ] || { echo "bad args: $*"; exit 2; }
printf '\\342\\224\\214  Add credential\\n\\342\\224\\202\\n\\342\\227\\217  Go to: https://auth.openai.com/codex/device\\n\\342\\224\\202\\n\\342\\227\\217  Enter code: 4W8Z-KL1KB\\n'
printf '\\033[999D\\033[J  Waiting for authorization'
[ "$FAKE_FAIL" = 1 ] && { printf '\\n  Failed to authorize\\n'; exit 0; }
mkdir -p "$XDG_DATA_HOME/opencode"
printf '{"openai":{"type":"oauth","refresh":"r","access":"a","expires":1}}' > "$XDG_DATA_HOME/opencode/auth.json"
`;

/** Stands in for `agent login`: a page, polled until signed in; it keeps the login itself. */
const FAKE_CURSOR = `#!/bin/sh
[ "$NO_OPEN_BROWSER" = 1 ] || { echo "would open a browser"; exit 2; }
echo "Waiting for browser authentication..."
echo "Open a browser and navigate to this link: https://cursor.com/loginDeepControl?challenge=c&uuid=u&mode=login&redirectTarget=cli"
sleep 0.2
[ "$FAKE_FAIL" = 1 ] && { echo "Login failed: expired"; exit 1; }
echo "Login successful!"
`;

/** Stands in for `agy acp --login`: a Google page, a pasted code read as a line; it keeps the login itself. */
const FAKE_AGY = `#!/bin/sh
[ "$*" = "acp --login" ] || { echo "bad args: $*"; exit 2; }
printf 'Open this link in a browser to log in with Google:\\n\\n  https://accounts.google.com/o/oauth2/auth?client_id=x&redirect_uri=https%%3A%%2F%%2Fantigravity.google%%2Foauth-callback\\n\\n'
printf 'Then paste the authorization code, or the full URL of the page you land on, and press Enter:\\n'
read code
[ "$code" = "4/good" ] || { echo "couldn't log in: token exchange failed: invalid_grant"; exit 1; }
echo "Authenticated as someone"
`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'browser-sign-in-test-'));
});

afterEach(async () => {
  delete process.env.FAKE_CODEX_FAIL;
  delete process.env.FAKE_FAIL;
  await rm(dir, { recursive: true, force: true });
});

async function fake(name: string, script: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, script);
  await chmod(path, 0o755);
  return path;
}

function start(provider: BrowserSignInProvider, binaryPath: string, timeoutMs = 20_000) {
  const pages: SignInPage[] = [];
  const signIn = startBrowserSignIn({
    provider,
    binaryPath,
    timeoutMs,
    signal: new AbortController().signal,
    onPage: (page) => pages.push(page),
  });
  return { signIn, pages };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 25));
  expect(check()).toBe(true);
}

const unix = process.platform === 'linux' || process.platform === 'darwin';

describe.runIf(unix)('startBrowserSignIn', () => {
  it('signs Claude Code in under a terminal: the link, the pasted code, the token', async () => {
    const { signIn, pages } = start('claude', await fake('claude', FAKE_CLAUDE));
    await until(() => pages.at(-1)?.needsCode === true);
    expect(pages.at(-1)).toEqual({
      url: 'https://claude.ai/oauth/authorize?code=true&x=1',
      userCode: null,
      needsCode: true,
    });
    signIn.enterCode('  good#code ');
    await expect(signIn.done).resolves.toEqual({ kind: 'setup-token', credential: TOKEN });
  });

  it("fails with the CLI's last lines, the code typed left out, when it gives no token", async () => {
    const { signIn, pages } = start('claude', await fake('claude', FAKE_CLAUDE));
    await until(() => pages.length > 0);
    signIn.enterCode('bad-code');
    const error = await signIn.done.then(
      () => null,
      (caught: Error) => caught
    );
    expect(error?.message).toContain('without a token');
    expect(error?.message).toContain('OAuth error: invalid code');
    expect(error?.message).not.toContain('bad-code');
  });

  it('signs Codex in by device code and reads the auth.json it wrote', async () => {
    const { signIn, pages } = start('codex', await fake('codex', FAKE_CODEX));
    await expect(signIn.done).resolves.toEqual({
      kind: 'auth-json',
      credential: '{"tokens":{"id_token":"x"}}',
    });
    expect(pages).toEqual([
      { url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGHI', needsCode: false },
    ]);
  });

  it('fails when Codex ends without signing in', async () => {
    process.env.FAKE_CODEX_FAIL = '1';
    const { signIn } = start('codex', await fake('codex', FAKE_CODEX));
    await expect(signIn.done).rejects.toThrow(/without signing in[\s\S]*device code expired/);
  });

  it('signs OpenCode in to ChatGPT by device code and reads the auth.json it wrote', async () => {
    const { signIn, pages } = start('opencode', await fake('opencode', FAKE_OPENCODE));
    await expect(signIn.done).resolves.toEqual({
      kind: 'auth-json',
      credential: '{"openai":{"type":"oauth","refresh":"r","access":"a","expires":1}}',
    });
    expect(pages).toEqual([
      { url: 'https://auth.openai.com/codex/device', userCode: '4W8Z-KL1KB', needsCode: false },
    ]);
  });

  it('fails when OpenCode ends saying nothing but saving no sign-in', async () => {
    process.env.FAKE_FAIL = '1';
    const { signIn } = start('opencode', await fake('opencode', FAKE_OPENCODE));
    await expect(signIn.done).rejects.toThrow(/wrote no sign-in file/);
  });

  it('signs Cursor in on the machine itself: its page, then the CLI keeps the login', async () => {
    const { signIn, pages } = start('cursor', await fake('agent', FAKE_CURSOR));
    await expect(signIn.done).resolves.toEqual({ kind: 'kept-on-machine' });
    expect(pages).toEqual([
      {
        url: 'https://cursor.com/loginDeepControl?challenge=c&uuid=u&mode=login&redirectTarget=cli',
        userCode: null,
        needsCode: false,
      },
    ]);
  });

  it('fails when Cursor ends without signing in', async () => {
    process.env.FAKE_FAIL = '1';
    const { signIn } = start('cursor', await fake('agent', FAKE_CURSOR));
    await expect(signIn.done).rejects.toThrow(/agent login ended \(exit 1\)[\s\S]*expired/);
  });

  it('signs Antigravity in on the machine itself with the code pasted back as a line', async () => {
    const { signIn, pages } = start('antigravity', await fake('agy', FAKE_AGY));
    await until(() => pages.at(-1)?.needsCode === true);
    expect(pages.at(-1)).toEqual({
      url: 'https://accounts.google.com/o/oauth2/auth?client_id=x&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback',
      userCode: null,
      needsCode: true,
    });
    signIn.enterCode('4/good');
    await expect(signIn.done).resolves.toEqual({ kind: 'kept-on-machine' });
  });

  it("fails with agy's words, the code left out, when it refuses the code", async () => {
    const { signIn, pages } = start('antigravity', await fake('agy', FAKE_AGY));
    await until(() => pages.length > 0);
    signIn.enterCode('4/bad-code');
    const error = await signIn.done.then(
      () => null,
      (caught: Error) => caught
    );
    expect(error?.message).toContain('invalid_grant');
    expect(error?.message).not.toContain('4/bad-code');
  });

  it('refuses the retired Antigravity ACP wrapper, which agy never reads a sign-in from', async () => {
    const { signIn } = start('antigravity', await fake('antigravity-acp', FAKE_AGY));
    await expect(signIn.done).rejects.toThrow(/needs Google's agy CLI/);
  });

  it('kills a CLI that ignores being told to end', async () => {
    const stubborn = await fake(
      'opencode',
      `#!/bin/sh\ntrap '' TERM\necho "Go to: https://auth.openai.com/codex/device"\necho "Enter code: ABCD-EFGHI"\nwhile :; do sleep 1; done\n`
    );
    const { signIn, pages } = start('opencode', stubborn);
    await until(() => pages.length > 0);
    signIn.cancel('stop');
    await expect(signIn.done).rejects.toThrow('stop');
    // shortcut: proves the group gets SIGKILL by `pgrep`, which assumes no other test runs this path.
    await until(() => {
      try {
        execFileSync('pgrep', ['-f', stubborn]);
        return false;
      } catch {
        return true;
      }
    });
  });

  it('ends a sign-in that is cancelled or runs out of time', async () => {
    const waiting = start('claude', await fake('claude', FAKE_CLAUDE));
    await until(() => waiting.pages.length > 0);
    waiting.signIn.cancel('The sign-in was cancelled.');
    await expect(waiting.signIn.done).rejects.toThrow('The sign-in was cancelled.');
    expect(() => waiting.signIn.enterCode('good#code')).toThrow(/already ended/);

    const slow = start('claude', await fake('claude', FAKE_CLAUDE), 500);
    await expect(slow.signIn.done).rejects.toThrow(/not finished within/);
  });

  it('refuses a code that is not one line', async () => {
    const { signIn, pages } = start('claude', await fake('claude', FAKE_CLAUDE));
    await until(() => pages.length > 0);
    expect(() => signIn.enterCode('a\nb')).toThrow(/not one line/);
    signIn.cancel('done');
    await signIn.done.catch(() => {});
  });
});
