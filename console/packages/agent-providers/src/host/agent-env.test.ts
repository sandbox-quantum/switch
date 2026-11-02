import { describe, expect, it } from 'vitest';
import { codexKeyringReaderEnvironment } from './agent-env';

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
