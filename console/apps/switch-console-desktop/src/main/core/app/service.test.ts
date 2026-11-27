import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type * as os from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  getVersion: vi.fn(() => '1.1.27'),
  openExternal: vi.fn(),
  openPath: vi.fn(),
  showItemInFolder: vi.fn(),
  home: { path: '' },
}));

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof os>()),
  homedir: () => mocks.home.path,
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
    showItemInFolder: mocks.showItemInFolder,
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

const { appService, fillOpenInTemplate } = await import('./service');

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    ...originalPlatform,
    value: platform,
  });
}

const home = realpathSync(mkdtempSync(join(tmpdir(), 'app-service-home-')));
mocks.home.path = home;
const folder = join(home, 'project');
mkdirSync(folder);
const file = join(home, 'notes.txt');
writeFileSync(file, 'not audio');
const bundle = join(home, 'Calculator.app');
mkdirSync(join(bundle, 'Contents'), { recursive: true });
writeFileSync(join(bundle, 'Contents', 'Info.plist'), '<plist/>');

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('AppService.openIn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform('win32');
    mocks.openPath.mockResolvedValue('');
    mocks.openExternal.mockResolvedValue(undefined);
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
    await appService.openIn({ app: 'finder', path: folder });

    expect(mocks.openPath).toHaveBeenCalledWith(folder);
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it('throws when Electron shell.openPath returns an error message', async () => {
    mocks.openPath.mockResolvedValueOnce('Path does not exist');

    await expect(appService.openIn({ app: 'finder', path: folder })).rejects.toThrow(
      'Path does not exist'
    );
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it('shows a file in the file manager rather than opening it', async () => {
    await appService.openIn({ app: 'finder', path: file });

    expect(mocks.showItemInFolder).toHaveBeenCalledWith(file);
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  it('shows a macOS app bundle rather than launching it', async () => {
    setPlatform('darwin');

    await appService.openIn({ app: 'finder', path: bundle });

    expect(mocks.showItemInFolder).toHaveBeenCalledWith(bundle);
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  it('refuses a path that does not exist, or is not absolute', async () => {
    await expect(appService.openIn({ app: 'finder', path: join(home, 'missing') })).rejects.toThrow(
      'ENOENT'
    );
    await expect(appService.openIn({ app: 'finder', path: 'project' })).rejects.toThrow(
      'project is not an absolute path.'
    );
    expect(mocks.openPath).not.toHaveBeenCalled();
    expect(mocks.showItemInFolder).not.toHaveBeenCalled();
  });

  it('refuses an app that is not in the registry, prototype names included', async () => {
    for (const app of ['calculator', 'constructor', 'toString']) {
      await expect(appService.openIn({ app: app as never, path: folder })).rejects.toThrow(
        'Invalid app ID'
      );
    }
  });

  it('hands an editor only a folder', async () => {
    await expect(appService.openIn({ app: 'vscode', path: file })).rejects.toThrow(
      `${file} is not a folder.`
    );
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it('refuses a folder name cmd.exe would act on in an unquoted Windows template', async () => {
    const risky = join(home, 'x&calc');
    mkdirSync(risky);

    await expect(appService.openIn({ app: 'terminal', path: risky })).rejects.toThrow(
      'cannot be opened safely'
    );
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it('encodes the folder into an app’s URL, so its name cannot change the action', async () => {
    setPlatform('darwin');
    const odd = join(home, 'a b?c#d');
    mkdirSync(odd);

    await appService.openIn({ app: 'warp', path: odd });

    expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(
      `warp://action/new_window?path=${encodeURIComponent(odd)}`
    );
  });

  it('fills a folder name that itself spells a placeholder only once, still quoted', async () => {
    setPlatform('linux');
    const tricky = join(home, "a{{path_raw}}'; touch pwned; '{{path}}$(id)");
    mkdirSync(tricky);

    await appService.openIn({ app: 'vscode', path: tricky });

    const quoted = `'${tricky.replace(/'/g, "'\\''")}'`;
    expect(mocks.exec).toHaveBeenCalledOnce();
    expect(mocks.exec.mock.calls[0][0]).toBe(`code ${quoted} || code-insiders ${quoted}`);
  });

  it('puts a raw Windows path in once, leaving placeholder text in it alone', async () => {
    const tricky = join(home, 'b{{path}} {{path_url}}');
    mkdirSync(tricky);

    await appService.openIn({ app: 'athas', path: tricky });

    expect(mocks.exec.mock.calls[0][0]).toBe(`athas "${tricky}"`);
  });
});

describe('fillOpenInTemplate', () => {
  it('replaces every placeholder in one pass, never re-reading what it inserted', () => {
    expect(
      fillOpenInTemplate('x {{path}} {{path_raw}} {{path}}', {
        path: "'{{path_raw}}'",
        path_raw: '{{path}};rm',
      })
    ).toBe("x '{{path_raw}}' {{path}};rm '{{path_raw}}'");
  });

  it('refuses a template naming a placeholder it was not given', () => {
    expect(() => fillOpenInTemplate('open {{path_url}}', { path: 'p' })).toThrow(
      'no value for {{path_url}}'
    );
  });
});

describe('AppService.openExternal', () => {
  it('opens the web and messaging-app links, and refuses other schemes', async () => {
    mocks.openExternal.mockResolvedValue(undefined);

    await appService.openExternal('slack://channel?team=T1&id=C1');
    expect(mocks.openExternal).toHaveBeenCalledWith('slack://channel?team=T1&id=C1');
    await expect(appService.openExternal('file:///etc/passwd')).rejects.toThrow(
      'Protocol "file:" is not allowed.'
    );
  });
});

describe('AppService.readAudioFileDataUrl', () => {
  it('judges the file by what a link resolves to, not by the link’s name', async () => {
    const link = join(home, 'song.mp3');
    symlinkSync(file, link);

    await expect(appService.readAudioFileDataUrl(link)).rejects.toThrow(
      'Unsupported audio file type'
    );
  });

  it('reads an audio file in the home folder', async () => {
    const song = join(home, 'chime.wav');
    writeFileSync(song, 'RIFF');

    expect(await appService.readAudioFileDataUrl(song)).toBe(
      `data:audio/wav;base64,${Buffer.from('RIFF').toString('base64')}`
    );
  });
});
