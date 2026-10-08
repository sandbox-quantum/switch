import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CommandFailure,
  type CommandRunner,
  CONTROLLER_CREDENTIAL,
  defaultSecretStoreKind,
  FileSecretStore,
  KeychainSecretStore,
  MemorySecretStore,
  SecretServiceStore,
} from './secrets';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'controller-secrets-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('FileSecretStore', () => {
  it('stores each secret in an owner-only file in an owner-only directory', async () => {
    const store = new FileSecretStore(join(dir, 'secrets'));
    expect(await store.get(CONTROLLER_CREDENTIAL)).toBeNull();
    await store.set(CONTROLLER_CREDENTIAL, 'credential-placeholder');
    expect(await store.get(CONTROLLER_CREDENTIAL)).toBe('credential-placeholder');
    expect(statSync(join(dir, 'secrets', CONTROLLER_CREDENTIAL)).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'secrets')).mode & 0o777).toBe(0o700);
    await store.set(CONTROLLER_CREDENTIAL, 'replaced');
    expect(await store.get(CONTROLLER_CREDENTIAL)).toBe('replaced');
    await store.delete(CONTROLLER_CREDENTIAL);
    await store.delete(CONTROLLER_CREDENTIAL);
    expect(await store.get(CONTROLLER_CREDENTIAL)).toBeNull();
  });

  it('refuses a secret file other users can read', async () => {
    const store = new FileSecretStore(join(dir, 'secrets'));
    await store.set(CONTROLLER_CREDENTIAL, 'credential-placeholder');
    chmodSync(join(dir, 'secrets', CONTROLLER_CREDENTIAL), 0o644);
    await expect(store.get(CONTROLLER_CREDENTIAL)).rejects.toThrow(/readable by other users/);
  });

  it('says at startup that no keychain protects the credential', () => {
    expect(new FileSecretStore(join(dir, 'secrets')).startupWarning()).toMatch(/No OS keychain/);
  });

  it('refuses a name that could leave its directory', async () => {
    const store = new FileSecretStore(join(dir, 'secrets'));
    await expect(store.set('../escape', 'x')).rejects.toThrow(/Invalid secret name/);
  });
});

describe('MemorySecretStore', () => {
  it('holds the handed-over credential in memory only, with no startup warning', async () => {
    const store = new MemorySecretStore(
      { [CONTROLLER_CREDENTIAL]: 'credential-placeholder' },
      'handed over on stdin'
    );
    expect(store.description).toBe('memory only (handed over on stdin)');
    expect(store.startupWarning()).toBeNull();
    expect(await store.get(CONTROLLER_CREDENTIAL)).toBe('credential-placeholder');
    await store.delete(CONTROLLER_CREDENTIAL);
    expect(await store.get(CONTROLLER_CREDENTIAL)).toBeNull();
    await store.set(CONTROLLER_CREDENTIAL, 'again');
    expect(await store.get(CONTROLLER_CREDENTIAL)).toBe('again');
  });

  it('refuses a name a file store would refuse', async () => {
    expect(() => new MemorySecretStore({ '../escape': 'x' }, 'test')).toThrow(/Invalid/);
    await expect(new MemorySecretStore({}, 'test').set('../x', 'y')).rejects.toThrow(/Invalid/);
  });
});

describe('OS keychain stores', () => {
  type Call = { file: string; args: string[]; input: string | null };
  function runner(answer: (call: Call) => { stdout: string } | CommandFailure) {
    const calls: Call[] = [];
    const run: CommandRunner = async (file, args, input) => {
      const call = { file, args, input };
      calls.push(call);
      const result = answer(call);
      if (result instanceof CommandFailure) throw result;
      return result;
    };
    return { calls, run };
  }

  it('keeps the macOS keychain value off the command line, and reads a missing one as none', async () => {
    const { calls, run } = runner((call) =>
      call.args[0] === 'find-generic-password'
        ? new CommandFailure(call.file, call.args, 44, 'not found', 'exit 44')
        : { stdout: '' }
    );
    const store = new KeychainSecretStore('/data', run);
    await store.set(CONTROLLER_CREDENTIAL, 'swcc_secret-value');
    expect(calls[0].args).toEqual(['-i']);
    expect(calls[0].input).toContain('-w "swcc_secret-value"');
    expect(calls[0].input).toContain(`-a "${CONTROLLER_CREDENTIAL}@/data"`);
    expect(calls.flatMap((call) => call.args).join(' ')).not.toContain('swcc_secret-value');
    expect(await store.get(CONTROLLER_CREDENTIAL)).toBeNull();
  });

  it('fails loud on a keychain error that is not "not found"', async () => {
    const { run } = runner(
      (call) => new CommandFailure(call.file, call.args, 51, 'user interaction is not allowed', 'x')
    );
    await expect(new KeychainSecretStore('/data', run).get(CONTROLLER_CREDENTIAL)).rejects.toThrow(
      /user interaction is not allowed/
    );
  });

  it('gives secret-tool the value on stdin, and reads a silent exit 1 as none', async () => {
    const { calls, run } = runner((call) =>
      call.args[0] === 'lookup'
        ? new CommandFailure(call.file, call.args, 1, '', 'exit 1')
        : { stdout: '' }
    );
    const store = new SecretServiceStore('/data', run);
    await store.set(CONTROLLER_CREDENTIAL, 'swcc_secret-value');
    expect(calls[0].input).toBe('swcc_secret-value');
    expect(calls[0].args).not.toContain('swcc_secret-value');
    expect(await store.get(CONTROLLER_CREDENTIAL)).toBeNull();
  });

  it('defaults to the keychain on a Mac only', () => {
    expect(defaultSecretStoreKind('darwin')).toBe('keychain');
    expect(defaultSecretStoreKind('linux')).toBe('file');
  });
});
