import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathScope } from './workspace-scope';

let home: string;
let work: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'scope-home-')));
  work = join(home, 'projects', 'app');
  mkdirSync(join(work, 'src'), { recursive: true });
  writeFileSync(join(work, 'src', 'a.ts'), 'export {};');
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const scopeIn = (cwd: string, path: string) => pathScope(path, { cwd, env: { HOME: home } }).scope;

describe('pathScope', () => {
  it('places files in the working directory, new ones included, in the workspace', () => {
    expect(scopeIn(work, 'src/a.ts')).toBe('workspace');
    expect(scopeIn(work, join(work, 'src', 'new', 'b.ts'))).toBe('workspace');
    expect(scopeIn(work, '.github/workflows/ci.yml')).toBe('workspace');
    expect(scopeIn(work, '.env')).toBe('workspace');
  });

  it('places anything beyond the working directory outside it', () => {
    expect(scopeIn(work, '../other/file.txt')).toBe('outside');
    expect(scopeIn(work, join(home, '.zshrc'))).toBe('outside');
    expect(scopeIn(work, '~/.ssh/id_ed25519')).toBe('outside');
    expect(scopeIn(work, '/etc/hosts')).toBe('outside');
  });

  it('follows links, a dangling one included, to where they lead', () => {
    symlinkSync(home, join(work, 'up'));
    symlinkSync(join(home, 'not-yet.txt'), join(work, 'dangling.txt'));
    symlinkSync(join(work, 'src'), join(work, 'source'));
    expect(scopeIn(work, 'up/.zshrc')).toBe('outside');
    expect(scopeIn(work, 'dangling.txt')).toBe('outside');
    expect(scopeIn(work, 'source/a.ts')).toBe('workspace');
  });

  it('places a file with another hard link outside, wherever the other is', () => {
    writeFileSync(join(home, '.zshrc'), 'export PATH=/usr/bin');
    linkSync(join(home, '.zshrc'), join(work, 'notes.txt'));
    linkSync(join(work, 'src', 'a.ts'), join(work, 'src', 'b.ts'));
    expect(scopeIn(work, 'notes.txt')).toBe('outside');
    expect(scopeIn(work, 'src/a.ts')).toBe('outside');
    expect(scopeIn(home, '.zshrc')).toBe('outside');
    expect(scopeIn(work, 'src')).toBe('workspace');
  });

  it("protects git's own directory inside the workspace", () => {
    expect(scopeIn(work, '.git/hooks/pre-commit')).toBe('protected');
    expect(scopeIn(work, '.git/config')).toBe('protected');
    expect(scopeIn(work, 'vendor/lib/.git/hooks/post-checkout')).toBe('protected');
  });

  it("protects the home directory's dot entries and Switch's state when the workspace is home", () => {
    expect(scopeIn(home, '.zshrc')).toBe('protected');
    expect(scopeIn(home, '.ssh/authorized_keys')).toBe('protected');
    expect(scopeIn(home, '.local/state/switch/sdk-watchers/abc/config.json')).toBe('protected');
    expect(
      scopeIn(home, 'Library/Application Support/Switch/agent-controller/watchers/a/config.json')
    ).toBe('protected');
    expect(
      scopeIn(
        home,
        'Library/Application Support/Switchdash/agent-controller/s/watchers/a/config.json'
      )
    ).toBe('protected');
    expect(scopeIn(home, 'projects/app/src/a.ts')).toBe('workspace');
  });

  it('leaves a dot folder the agent was put in to work on as its workspace', () => {
    const dotfiles = join(home, '.dotfiles');
    mkdirSync(dotfiles);
    expect(scopeIn(dotfiles, 'zshrc')).toBe('workspace');
    expect(scopeIn(dotfiles, '../.zshrc')).toBe('outside');
  });

  it('protects Switch application data named by the Windows variables', () => {
    const local = join(home, 'AppData', 'Local');
    const scope = pathScope(join(local, 'Switch', 'agent-controller', 'controller.db'), {
      cwd: home,
      env: { HOME: home, LOCALAPPDATA: local },
    });
    expect(scope.scope).toBe('protected');
  });

  it('names the real path it decided on', () => {
    symlinkSync(home, join(work, 'up'));
    expect(pathScope('up/.zshrc', { cwd: work, env: { HOME: home } })).toEqual({
      scope: 'outside',
      real: join(home, '.zshrc'),
    });
  });
});
