import { describe, expect, it } from 'vitest';
import { codexKeyringReaderEnvironment, EXECUTION_INHERIT_ENV } from './agent-env';
import { executionEnvironment } from './shared-config';

describe('codexKeyringReaderEnvironment', () => {
  const session = {
    PATH: '/usr/bin',
    HOME: '/home/user',
    CODEX_HOME: '/sessions/home',
    OPENAI_API_KEY: 'session-only',
    SWITCH_SERVICE_BEARER: 'session-only',
    GH_TOKEN: 'session-only',
  };

  it('gives the reader the basics and the host’s session bus, and none of the session’s credentials', () => {
    expect(
      codexKeyringReaderEnvironment(
        session,
        { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', SECRET: 'host-only' },
        'linux'
      )
    ).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/user',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    });
  });

  it('prefers a session bus the session already names', () => {
    expect(
      codexKeyringReaderEnvironment(
        { ...session, XDG_RUNTIME_DIR: '/run/user/1000' },
        { XDG_RUNTIME_DIR: '/run/user/other' },
        'linux'
      ).XDG_RUNTIME_DIR
    ).toBe('/run/user/1000');
  });

  it('matches names without regard to case on Windows only', () => {
    const windows = { Path: 'C:\\bin', SystemRoot: 'C:\\Windows', Switch_Service_Bearer: 'x' };
    expect(codexKeyringReaderEnvironment(windows, {}, 'win32')).toEqual({
      Path: 'C:\\bin',
      SystemRoot: 'C:\\Windows',
    });
    expect(codexKeyringReaderEnvironment(windows, {}, 'linux')).toEqual({});
  });
});

it('passes an OpenRouter key through the existing controller environment', async () => {
  const previous = process.env.OPENROUTER_API_KEY;
  try {
    process.env.OPENROUTER_API_KEY = 'synthetic-openrouter-secret';
    const env = await executionEnvironment(process.cwd(), {}, undefined, [
      ...EXECUTION_INHERIT_ENV,
    ]);
    expect(env.OPENROUTER_API_KEY).toBe('synthetic-openrouter-secret');
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  }
});
