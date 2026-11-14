import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const installSh = join(dirname(fileURLToPath(import.meta.url)), '..', 'install.sh');
const API = 'https://api.github.com/repos/sandbox-quantum/switch';
const DOWNLOAD = 'https://github.com/sandbox-quantum/switch/releases/download';
const PREFIX = 'switch-agent-controller-v';

interface Release {
  draft?: boolean;
  prerelease?: boolean;
  signed?: boolean;
}

/**
 * Runs install.sh with a `curl` on PATH that answers from `tags` and
 * `releases` instead of GitHub, and refuses every download. The download it
 * was asked for names the release the installer chose.
 */
function runInstaller(
  dir: string,
  tags: string[],
  releases: Record<string, Release | number>
): { status: number | null; stderr: string } {
  const answers: Record<string, { status: number; body: unknown }> = {
    [`${API}/git/matching-refs/tags/${PREFIX}`]: {
      status: 200,
      body: tags.map((tag) => ({ ref: `refs/tags/${PREFIX}${tag}` })),
    },
  };
  for (const [version, release] of Object.entries(releases)) {
    const url = `${API}/releases/tags/${PREFIX}${version}`;
    if (typeof release === 'number') {
      answers[url] = { status: release, body: { message: 'refused' } };
      continue;
    }
    const tgz = `switch-agent-controller-${version}.tgz`;
    const assets = [{ name: tgz, browser_download_url: `${DOWNLOAD}/${PREFIX}${version}/${tgz}` }];
    if (release.signed !== false) {
      assets.push({
        name: `${tgz}.sig`,
        browser_download_url: `${DOWNLOAD}/${PREFIX}${version}/${tgz}.sig`,
      });
    }
    answers[url] = {
      status: 200,
      body: { draft: release.draft ?? false, prerelease: release.prerelease ?? false, assets },
    };
  }
  writeFileSync(join(dir, 'answers.json'), JSON.stringify(answers));
  const curl = join(dir, 'curl');
  writeFileSync(
    curl,
    `#!/usr/bin/env node
const fs = require('node:fs');
const answers = JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, 'answers.json'))}, 'utf8'));
const args = process.argv.slice(2);
let out = null, format = null, url = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o') out = args[++i];
  else if (args[i] === '-w') format = args[++i];
  else if (args[i] === '-H') i++;
  else if (!args[i].startsWith('-')) url = args[i];
}
const answer = answers[url] || (format ? { status: 404, body: { message: 'Not Found' } } : null);
if (!answer) {
  process.stderr.write('fake curl: no answer for ' + url + '\\n');
  process.exit(22);
}
const body = JSON.stringify(answer.body);
if (out) fs.writeFileSync(out, body); else process.stdout.write(body);
if (format) process.stdout.write(String(answer.status));
process.exit(!format && answer.status >= 400 ? 22 : 0);
`
  );
  chmodSync(curl, 0o755);
  const result = spawnSync('sh', [installSh], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, HOME: dir },
  });
  return { status: result.status, stderr: result.stderr };
}

function downloadOf(version: string): string {
  return `Could not download ${DOWNLOAD}/${PREFIX}${version}/switch-agent-controller-${version}.tgz.`;
}

describe('install.sh choosing a release', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'install-sh-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds the newest signed release however many prereleases came after it', () => {
    const dev = Array.from({ length: 150 }, (_, n) => `0.32.1-dev.${n}.gabc1234`);
    const { status, stderr } = runInstaller(dir, ['0.31.0', '0.32.0', '0.33.0-rc.1', ...dev], {
      '0.31.0': { signed: false },
      '0.32.0': {},
    });

    expect(status).toBe(1);
    expect(stderr).toContain(downloadOf('0.32.0'));
  });

  it('orders versions by number, not by text', () => {
    const { stderr } = runInstaller(dir, ['0.9.0', '0.10.0'], { '0.9.0': {}, '0.10.0': {} });

    expect(stderr).toContain(downloadOf('0.10.0'));
  });

  it('passes over a tag with no release, a draft, a prerelease and an unsigned release', () => {
    const { stderr } = runInstaller(dir, ['0.30.0', '0.31.0', '0.32.0', '0.33.0', '0.34.0'], {
      '0.30.0': {},
      '0.31.0': { signed: false },
      '0.32.0': { prerelease: true },
      '0.33.0': { draft: true },
    });

    expect(stderr).toContain(downloadOf('0.30.0'));
  });

  it('says so when no release is signed, rather than choosing one it cannot install', () => {
    const { status, stderr } = runInstaller(dir, ['0.1.1', '0.31.0'], {
      '0.1.1': { signed: false },
      '0.31.0': { signed: false },
    });

    expect(status).toBe(1);
    expect(stderr).toContain('has no published, signed switch-agent-controller release yet');
  });

  it('fails on a refusal from GitHub rather than passing over the release', () => {
    const { status, stderr } = runInstaller(dir, ['0.31.0', '0.32.0'], {
      '0.31.0': {},
      '0.32.0': 403,
    });

    expect(status).toBe(1);
    expect(stderr).toContain(`GitHub answered HTTP 403 for the release ${PREFIX}0.32.0`);
  });
});
