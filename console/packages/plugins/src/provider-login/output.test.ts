import { describe, expect, it } from 'vitest';
import { asksForCode, deviceCodeIn, linesOf, linksIn, setupTokenIn, terminalText } from './output';

/** What `claude setup-token` 2.1 drew in a terminal, as captured (link shortened). */
const CLAUDE_SETUP_TOKEN =
  '\x1b[2G·\x1b[4GOpening\x1b[12Gbrowser\x1b[20Gto\x1b[23Gsign\x1b[28Gin…\r\r\n' +
  "\r\x1b[1C\x1b[1ABrowser didn't open?\x1b[23GUse the URL\x1b[35Gbelow\r\r\n\r\r\n" +
  '\x1b]8;id=byl4o6;https://claude.ai/oauth/authorize?Iz2av_CoFPYl\x07' +
  'https://claude.ai/oauth/authorize?Iz2av_CoFPYl\x1b]8;;\x07\r\r\n\r\r\n' +
  '\x1b[2GPaste\x1b[8Gcode\x1b[13Ghere\x1b[18Gif\x1b[21Gprompted\r\r\n' +
  '\x1b[2G│\x1b[4G\x1b[7m \x1b[1000G\x1b[27m│\r\r\n\x1b[3C\x1b[2A';

/** What `codex login --device-auth` 0.169 printed, as captured. */
const CODEX_DEVICE_AUTH =
  '\nWelcome to Codex [v\x1b[90m0.169.0\x1b[0m]\n' +
  'Follow these steps to sign in with ChatGPT using device code authorization:\n\n' +
  '1. Open this link in your browser and sign in to your account\n' +
  '   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n' +
  '2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n' +
  '   \x1b[94m4ONM-GH7LQ\x1b[0m\n';

/** What `opencode auth login` 1.18 printed for ChatGPT's device code, as captured. */
const OPENCODE_DEVICE_AUTH =
  '\x1b[0m\n┌  Add credential\n│\n●  Go to: https://auth.openai.com/codex/device\n│\n' +
  '●  Enter code: 4W8Z-KL1KB\n\x1b[?25l│\n◒  Waiting for authorization' +
  '\x1b[999D\x1b[J◐  Waiting for authorization.';

/** What Cursor's `agent login` 2026.11 printed without a browser to open, as captured (link shortened). */
const CURSOR_LOGIN =
  'Starting login process...\nAuthenticating with Cursor...\nWaiting for browser authentication...\n' +
  'Open a browser and navigate to this link: https://cursor.com/loginDeepControl?challenge=S1nq&uuid=246e&mode=login&redirectTarget=cli\n';

/** What `agy acp --login` 1.5 printed, as captured (link shortened). */
const AGY_LOGIN =
  'Open this link in a browser to log in with Google:\r\n\r\n' +
  '  https://accounts.google.com/o/oauth2/auth?access_type=offline&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=Vb\r\n\r\n' +
  'Then paste the authorization code, or the full URL of the page you land on, and press Enter:\r\n';

describe('provider sign-in output', () => {
  it('finds each link once, in order', () => {
    expect(
      linksIn([
        'Open https://a.example/x to sign in',
        'or https://b.example',
        'https://a.example/x',
      ])
    ).toEqual(['https://a.example/x', 'https://b.example']);
  });

  it("leaves out a CLI's own callback server and the full stop after a link", () => {
    expect(
      linksIn([
        'Starting local login server on http://localhost:1455.',
        'If your browser did not open, navigate to this URL to authenticate:',
        'https://auth.openai.com/oauth/authorize?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455',
        'or see https://example.com/help.',
      ])
    ).toEqual([
      'https://auth.openai.com/oauth/authorize?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455',
      'https://example.com/help',
    ]);
  });

  it('notices a command waiting for a pasted code', () => {
    expect(asksForCode(['Browser didn’t open?', 'Paste code here if prompted >'])).toBe(true);
    expect(
      asksForCode([
        "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=x",
      ])
    ).toBe(true);
    expect(asksForCode(['Opening your browser to sign in…'])).toBe(false);
    expect(asksForCode(['Visit https://auth.example/device?user_code=ABCD'])).toBe(false);
  });
});

describe('a sign-in drawn in a terminal', () => {
  it("reads Claude Code's setup-token screen: one link, and a code to paste", () => {
    const lines = linesOf(terminalText(CLAUDE_SETUP_TOKEN));
    expect(linksIn(lines)).toEqual(['https://claude.ai/oauth/authorize?Iz2av_CoFPYl']);
    expect(asksForCode(lines)).toBe(true);
    expect(lines.some((line) => /\x1b/.test(line))).toBe(false);
  });

  it("reads Codex's device sign-in: its page and the one-time code", () => {
    const lines = linesOf(terminalText(CODEX_DEVICE_AUTH));
    expect(linksIn(lines)).toEqual(['https://auth.openai.com/codex/device']);
    expect(deviceCodeIn(lines)).toBe('4ONM-GH7LQ');
    expect(asksForCode(lines)).toBe(false);
  });

  it("reads OpenCode's ChatGPT device sign-in through its spinner", () => {
    const lines = linesOf(terminalText(OPENCODE_DEVICE_AUTH));
    expect(linksIn(lines)).toEqual(['https://auth.openai.com/codex/device']);
    expect(deviceCodeIn(lines)).toBe('4W8Z-KL1KB');
    expect(asksForCode(lines)).toBe(false);
  });

  it("reads Cursor's login: one page, nothing to type", () => {
    const lines = linesOf(terminalText(CURSOR_LOGIN));
    expect(linksIn(lines)).toEqual([
      'https://cursor.com/loginDeepControl?challenge=S1nq&uuid=246e&mode=login&redirectTarget=cli',
    ]);
    expect(deviceCodeIn(lines)).toBeNull();
    expect(asksForCode(lines)).toBe(false);
  });

  it("reads agy's Google sign-in: its page, and a code to paste back", () => {
    const lines = linesOf(terminalText(AGY_LOGIN));
    expect(linksIn(lines)).toEqual([
      'https://accounts.google.com/o/oauth2/auth?access_type=offline&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=Vb',
    ]);
    expect(asksForCode(lines)).toBe(true);
  });

  it('keeps a hyperlink whole when its text wraps', () => {
    const text = terminalText(
      '\x1b]8;id=1;https://example.com/a-long-link\x07https://example.com/a-\r\nlong-link\x1b]8;;\x07'
    );
    expect(linksIn(linesOf(text))[0]).toBe('https://example.com/a-long-link');
  });

  it('finds no device code in a link', () => {
    expect(deviceCodeIn(['https://auth.example/ABCD-EFGH'])).toBeNull();
  });

  it('finds the setup token printed last', () => {
    const token = `sk-ant-oat01-${'a'.repeat(40)}-${'B'.repeat(20)}AA`;
    expect(setupTokenIn(terminalText(`Your OAuth token:\r\n\x1b[2G${token}\r\n`))).toBe(token);
    expect(setupTokenIn('Paste code here if prompted')).toBeNull();
  });
});
