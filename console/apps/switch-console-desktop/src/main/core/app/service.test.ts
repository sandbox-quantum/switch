import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  getVersion: vi.fn(() => '1.1.27'),
  openExternal: vi.fn(),
  openPath: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  exec: mocks.exec,
}));

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => ''),
    getVersion: mocks.getVersion,
    quit: vi.fn(),
  },
  clipboard: {
    writeText: vi.fn(),
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
  shell: {
    openExternal: mocks.openExternal,
    openPath: mocks.openPath,
  },
}));

vi.mock('@main/app/window', () => ({
  getMainWindow: vi.fn(),
}));

vi.mock('@main/db/client', () => ({
  db: {},
}));

vi.mock('@main/db/schema', () => ({
  sshConnections: {},
}));

vi.mock('@main/lib/events', () => ({
  events: {
    on: vi.fn(() => vi.fn()),
  },
}));

vi.mock('@main/lib/logger', () => ({
  log: {
    error: vi.fn(),
  },
}));

vi.mock('@main/utils/childProcessEnv', () => ({
  buildExternalToolEnv: () => ({}),
}));

const { appService } = await import('./service');

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    ...originalPlatform,
    value: platform,
  });
}

describe('AppService.openIn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform('win32');
    mocks.openPath.mockResolvedValue('');
    mocks.exec.mockImplementation(
      (_command: string, _options: object, callback: (error: Error | null) => void) => {
        callback(null);
      }
    );
  });

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  });

  it('opens the platform file manager with Electron shell.openPath instead of a shell command', async () => {
    const target = 'C:/Users/Qwenzy/Desktop/ees_ams';

    await appService.openIn({ app: 'finder', path: target });

    expect(mocks.openPath).toHaveBeenCalledWith(target);
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it('throws when Electron shell.openPath returns an error message', async () => {
    const target = 'C:/Users/Qwenzy/Desktop/missing';
    mocks.openPath.mockResolvedValueOnce('Path does not exist');

    await expect(appService.openIn({ app: 'finder', path: target })).rejects.toThrow(
      'Path does not exist'
    );
    expect(mocks.openPath).toHaveBeenCalledWith(target);
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it('rejects paths containing control characters', async () => {
    await expect(
      appService.openIn({ app: 'vscode', path: '/tmp/project\nrm -rf /' })
    ).rejects.toThrow('Invalid path: contains control characters');

    await expect(
      appService.openIn({ app: 'vscode', path: '/tmp/project\0hidden' })
    ).rejects.toThrow('Invalid path: contains control characters');
  });

  it('rejects paths containing forbidden characters on Windows', async () => {
    setPlatform('win32');
    await expect(
      appService.openIn({ app: 'athas', path: 'C:\\Users\\Public" & calc.exe & "' })
    ).rejects.toThrow('Invalid path: contains invalid characters');

    await expect(
      appService.openIn({ app: 'vscode', path: 'C:\\Users\\Public<test>' })
    ).rejects.toThrow('Invalid path: contains invalid characters');

    await expect(
      appService.openIn({ app: 'terminal', path: 'C:\\Users\\Public|dir' })
    ).rejects.toThrow('Invalid path: contains invalid characters');
  });

  it('safely escapes single quotes, {{path_raw}}, and special replace patterns on POSIX platforms', async () => {
    setPlatform('darwin');
    const maliciousTarget = "/tmp/{{path_raw}}'; touch /tmp/pwned #";

    await appService.openIn({ app: 'vscode', path: maliciousTarget });

    expect(mocks.exec).toHaveBeenCalled();
    const executedCommand = mocks.exec.mock.calls[0][0];
    expect(executedCommand).toContain("code '/tmp/{{path_raw}}'\\''; touch /tmp/pwned #'");
    expect(executedCommand).not.toContain("'/tmp//tmp/");
  });

  it("safely handles paths containing $' on POSIX without corrupting quote delimiters", async () => {
    setPlatform('linux');
    const dollarTarget = "/tmp/project$'injection";

    await appService.openIn({ app: 'vscode', path: dollarTarget });

    expect(mocks.exec).toHaveBeenCalled();
    const executedCommand = mocks.exec.mock.calls[0][0];
    expect(executedCommand).toContain("code '/tmp/project$'\\''injection'");
  });

  it('safely handles {{path_raw}} placeholders in commands on Windows', async () => {
    setPlatform('win32');
    const target = 'C:\\Users\\Public\\My Project';

    await appService.openIn({ app: 'athas', path: target });

    expect(mocks.exec).toHaveBeenCalled();
    const executedCommand = mocks.exec.mock.calls[0][0];
    expect(executedCommand).toBe('athas "C:\\Users\\Public\\My Project"');
  });

  it('keeps a {{path_raw}} placeholder inside its template-supplied quotes even when other text precedes it', async () => {
    setPlatform('win32');
    // '&' is a legal Windows path character and is not rejected by the invalid-character
    // check; it must stay inside the literal quotes the "terminal" template already wraps
    // around {{path_raw}}, or cmd.exe would split it into a second, injected command.
    const target = 'C:\\Users\\Public & calc.exe & echo pwned';

    await appService.openIn({ app: 'terminal', path: target });

    expect(mocks.exec).toHaveBeenCalled();
    const executedCommand = mocks.exec.mock.calls[0][0];
    expect(executedCommand).toBe(
      'wt -d "C:\\Users\\Public & calc.exe & echo pwned" || ' +
        'start cmd /K "cd /d C:\\Users\\Public & calc.exe & echo pwned"'
    );
    // A re-nested quote (`""`) here would mean the path spilled outside the quoted segment.
    expect(executedCommand).not.toContain('""');
  });
});
