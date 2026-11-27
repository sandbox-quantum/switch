import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateSealingKeyPair,
  openProviderLogin,
  type SealedLogin,
} from '@switch-console/agent-providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ControllerApiError } from './api';
import { type BrowserLoginDeps, signInWithBrowser } from './browser-login';
import { silentLogger } from './log';
import type { OperationProgress, ProviderStatus } from './schemas';

const TOKEN = `sk-ant-oat01-${'b'.repeat(40)}AA`;

const FAKE_CLAUDE = `#!/bin/sh
printf '\\033]8;id=1;https://claude.ai/oauth/authorize?code=true\\007https://claude.ai/oauth/authorize?code=true\\033]8;;\\007\\n'
printf ' Paste code here if prompted > '
read code
[ "$code" = "good#code" ] || { echo "OAuth error: invalid code"; exit 1; }
printf '\\n${TOKEN}\\n'
`;

const signedIn: ProviderStatus = {
  provider: 'claude',
  installed: true,
  version: '2.1.0',
  auth: 'ok',
  auth_source: 'sealed',
  checked_at: '2026-01-01T00:00:00Z',
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'browser-login-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fakeClaude(): Promise<string> {
  const path = join(dir, 'claude');
  await writeFile(path, FAKE_CLAUDE);
  await chmod(path, 0o755);
  return path;
}

function harness(overrides: Partial<BrowserLoginDeps> & { code?: string } = {}) {
  const reports: OperationProgress[] = [];
  const kept: SealedLogin[] = [];
  const takenUp: string[] = [];
  const keys = generateSealingKeyPair();
  let codeSent = false;
  const deps: BrowserLoginDeps = {
    client: {
      operationProgress: async (_id, progress) => {
        reports.push(progress);
        if (progress.sign_in?.needs_code && !codeSent) {
          codeSent = true;
          return { code: overrides.code ?? 'good#code' };
        }
        return null;
      },
      keepBrowserLogin: async (_id, sealed) => {
        kept.push(sealed);
      },
    },
    keys,
    controllerId: 'controller-1',
    binaryPath: async () => null,
    takeUpLogin: async (provider) => {
      takenUp.push(provider);
      return { status: signedIn, problem: null };
    },
    signal: new AbortController().signal,
    timeoutMs: 20_000,
    progressEveryMs: 20,
    log: silentLogger,
    ...overrides,
  };
  return { deps, reports, kept, takenUp, keys };
}

const unix = process.platform === 'linux' || process.platform === 'darwin';
/** Starting a CLI under a terminal is slow on a loaded machine. */
const SLOW = 30_000;

describe('signInWithBrowser', { timeout: SLOW }, () => {
  it.runIf(unix)(
    'reports the page, types the code sent, keeps the token sealed and takes it up',
    async () => {
      const binary = await fakeClaude();
      const { deps, reports, kept, takenUp, keys } = harness({ binaryPath: async () => binary });
      expect(await signInWithBrowser('op-1', 'claude', deps)).toEqual({
        outcome: 'succeeded',
        output: { provider: signedIn },
      });
      expect(reports).toContainEqual({
        message: 'Waiting for the code the sign-in page shows',
        sign_in: { url: 'https://claude.ai/oauth/authorize?code=true', needs_code: true },
      });
      expect(kept).toHaveLength(1);
      expect(
        openProviderLogin({
          keys,
          controllerId: 'controller-1',
          provider: 'claude',
          sealed: kept[0]!,
        })
      ).toEqual({ kind: 'setup-token', credential: TOKEN });
      expect(takenUp).toEqual(['claude']);
      expect(JSON.stringify(reports)).not.toContain(TOKEN);
    }
  );

  it.runIf(unix)('fails with what the CLI said when the code does not sign in', async () => {
    const binary = await fakeClaude();
    const { deps, kept } = harness({ binaryPath: async () => binary, code: 'wrong' });
    const result = await signInWithBrowser('op-1', 'claude', deps);
    expect(result).toMatchObject({ outcome: 'failed', error: { code: 'provider_login_missing' } });
    expect(JSON.stringify(result)).toContain('OAuth error: invalid code');
    expect(kept).toEqual([]);
  });

  it.runIf(unix)('stops the sign-in when Switch cancels the operation', async () => {
    const binary = await fakeClaude();
    const cancelled = new ControllerApiError(410, 'cancelled', 'cancelled', false, null);
    const { deps, kept } = harness({
      binaryPath: async () => binary,
      client: {
        operationProgress: async () => {
          throw cancelled;
        },
        keepBrowserLogin: async () => {},
      },
    });
    await expect(signInWithBrowser('op-1', 'claude', deps)).rejects.toBe(cancelled);
    expect(kept).toEqual([]);
  });

  it.runIf(unix)(
    'leaves a CLI that keeps its own login signed in here, sealing nothing, and checks it',
    async () => {
      const path = join(dir, 'agent');
      await writeFile(
        path,
        '#!/bin/sh\necho "Open a browser and navigate to this link: https://cursor.com/loginDeepControl?uuid=u"\nsleep 0.2\n'
      );
      await chmod(path, 0o755);
      const { deps, reports, kept, takenUp } = harness({ binaryPath: async () => path });
      expect(await signInWithBrowser('op-1', 'cursor', deps)).toEqual({
        outcome: 'succeeded',
        output: { provider: signedIn },
      });
      expect(reports).toContainEqual({
        message: 'Waiting for the sign-in to finish',
        sign_in: { url: 'https://cursor.com/loginDeepControl?uuid=u', needs_code: false },
      });
      expect(kept).toEqual([]);
      expect(takenUp).toEqual(['cursor']);
    }
  );

  it('refuses without a key to keep the login with, or without the CLI', async () => {
    expect(await signInWithBrowser('op-1', 'codex', harness({ keys: null }).deps)).toMatchObject({
      error: { code: 'operation_unsupported' },
    });
    expect(await signInWithBrowser('op-1', 'codex', harness().deps)).toMatchObject({
      error: { code: 'provider_not_installed' },
    });
  });
});
