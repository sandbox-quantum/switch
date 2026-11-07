import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDeepseekHarnessAdapter,
  deepseekHarnessAcp,
  DSH_LOGIN,
  findDeepseekApiKey,
} from './deepseek-harness-acp';

describe('deepseekHarnessAcp', () => {
  it('declares the expected provider identification and capabilities', () => {
    expect(deepseekHarnessAcp.provider).toBe('deepseek-harness');
    expect(deepseekHarnessAcp.label).toBe('DeepSeek Harness');
    expect(deepseekHarnessAcp.defaultBinary).toBe('dsh');
    expect(deepseekHarnessAcp.loginCommand).toBe(DSH_LOGIN);
    expect(deepseekHarnessAcp.inheritEnv).toContain('DEEPSEEK_API_KEY');
    expect(deepseekHarnessAcp.inheritEnv).toContain('DEEPSEEK_BASE_URL');
    expect(deepseekHarnessAcp.inheritEnv).toContain('DSH_HOME');
    expect(deepseekHarnessAcp.capabilities).toEqual({
      modelSwitchInSession: true,
      steering: false,
      resume: true,
      approvals: true,
      userInput: false,
    });
  });

  it('launches dsh with --profile acp', async () => {
    const launch = await deepseekHarnessAcp.launch({
      binaryPath: '/custom/path/dsh',
      cwd: '/workspace',
      env: { DEEPSEEK_API_KEY: 'sk-test' },
    });

    expect(launch.command).toBe('/custom/path/dsh');
    expect(launch.args).toEqual(['--profile', 'acp']);
    expect(launch.env).toEqual({ DEEPSEEK_API_KEY: 'sk-test' });
  });

  describe('findDeepseekApiKey', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'dsh-test-'));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it('finds API key in env', async () => {
      const key = await findDeepseekApiKey({ DEEPSEEK_API_KEY: 'sk-env-key' });
      expect(key).toBe('sk-env-key');
    });

    it('finds API key in local .env', async () => {
      await writeFile(join(tempDir, '.env'), 'DEEPSEEK_API_KEY=sk-local-dotenv\n');
      const key = await findDeepseekApiKey({}, tempDir);
      expect(key).toBe('sk-local-dotenv');
    });

    it('finds API key in DSH_HOME credentials.yaml', async () => {
      const dshHome = join(tempDir, 'custom-dsh');
      await mkdir(dshHome, { recursive: true });
      await writeFile(
        join(dshHome, '.credentials.yaml'),
        'refs:\n  DEEPSEEK_API_KEY: "sk-yaml-key"\n'
      );

      const key = await findDeepseekApiKey({ DSH_HOME: dshHome });
      expect(key).toBe('sk-yaml-key');
    });

    it('finds API key in DSH_HOME .env', async () => {
      const dshHome = join(tempDir, 'custom-dsh-env');
      await mkdir(dshHome, { recursive: true });
      await writeFile(join(dshHome, '.env'), 'DEEPSEEK_API_KEY="sk-dsh-env-key"\n');

      const key = await findDeepseekApiKey({ DSH_HOME: dshHome });
      expect(key).toBe('sk-dsh-env-key');
    });

    it('returns undefined when no key exists', async () => {
      const key = await findDeepseekApiKey({ DSH_HOME: tempDir }, tempDir);
      expect(key).toBeUndefined();
    });
  });

  describe('checkSignIn', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'dsh-signin-'));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it('reports authenticated when DEEPSEEK_API_KEY is present in env', async () => {
      const result = await deepseekHarnessAcp.checkSignIn?.({
        binaryPath: 'dsh',
        cwd: tempDir,
        env: { DEEPSEEK_API_KEY: 'sk-test-key' },
        handshake: async () => ({ authMethods: [] }) as never,
      });

      expect(result).toBeDefined();
      expect(result?.status).toBe('authenticated');
      expect(result?.message).toContain('DeepSeek API key');
    });

    it('reports authenticated when key is discovered from local .env', async () => {
      await writeFile(join(tempDir, '.env'), 'DEEPSEEK_API_KEY=sk-file-key\n');
      const result = await deepseekHarnessAcp.checkSignIn?.({
        binaryPath: 'dsh',
        cwd: tempDir,
        env: { DSH_HOME: tempDir },
        handshake: async () => ({ authMethods: [] }) as never,
      });

      expect(result).toBeDefined();
      expect(result?.status).toBe('authenticated');
    });

    it('reports unauthenticated when handshake returns empty authMethods and no credentials exist', async () => {
      // Prevents the dsh-acp empty authMethods false-positive
      const result = await deepseekHarnessAcp.checkSignIn?.({
        binaryPath: 'dsh',
        cwd: tempDir,
        env: { DSH_HOME: tempDir },
        handshake: async () => ({ authMethods: [] }) as never,
      });

      expect(result).toBeDefined();
      expect(result?.status).toBe('unauthenticated');
      expect(result?.message).toContain(DSH_LOGIN);
    });

    it('reports unauthenticated when handshake returns authMethods array with entries', async () => {
      const result = await deepseekHarnessAcp.checkSignIn?.({
        binaryPath: 'dsh',
        cwd: tempDir,
        env: { DSH_HOME: tempDir },
        handshake: async () => ({ authMethods: [{ id: 'oauth', name: 'DeepSeek' }] }) as never,
      });

      expect(result).toBeDefined();
      expect(result?.status).toBe('unauthenticated');
      expect(result?.message).toContain(DSH_LOGIN);
    });

    it('reports unauthenticated when handshake throws an authentication error', async () => {
      const result = await deepseekHarnessAcp.checkSignIn?.({
        binaryPath: 'dsh',
        cwd: tempDir,
        env: { DSH_HOME: tempDir },
        handshake: async () => {
          throw new Error('Authentication required');
        },
      });

      expect(result).toBeDefined();
      expect(result?.status).toBe('unauthenticated');
      expect(result?.message).toContain(DSH_LOGIN);
    });

    it('reports unknown when handshake throws an unexpected non-auth error with no credentials', async () => {
      const result = await deepseekHarnessAcp.checkSignIn?.({
        binaryPath: 'dsh',
        cwd: tempDir,
        env: { DSH_HOME: tempDir },
        handshake: async () => {
          throw new Error('ECONNREFUSED');
        },
      });

      expect(result).toBeDefined();
      expect(result?.status).toBe('unknown');
      expect(result?.message).toContain(DSH_LOGIN);
    });
  });

  describe('itemType', () => {
    it('maps write and edit tools to file_change', () => {
      expect(
        deepseekHarnessAcp.itemType?.({
          toolCallId: '1',
          title: 'write',
          status: 'completed',
        })
      ).toBe('file_change');
      expect(
        deepseekHarnessAcp.itemType?.({
          toolCallId: '2',
          title: 'edit',
          status: 'completed',
        })
      ).toBe('file_change');
      expect(
        deepseekHarnessAcp.itemType?.({
          toolCallId: '3',
          title: 'write_file',
          status: 'completed',
        })
      ).toBe('file_change');
      expect(
        deepseekHarnessAcp.itemType?.({
          toolCallId: '4',
          title: 'edit_file',
          status: 'completed',
        })
      ).toBe('file_change');
      expect(
        deepseekHarnessAcp.itemType?.({
          toolCallId: '5',
          title: 'apply_patch',
          status: 'completed',
        })
      ).toBe('file_change');
    });

    it('maps bash, command, exec, shell, and pwsh tools to command_execution', () => {
      expect(
        deepseekHarnessAcp.itemType?.({
          toolCallId: '1',
          title: 'bash',
          status: 'completed',
        })
      ).toBe('command_execution');
      expect(
        deepseekHarnessAcp.itemType?.({
          toolCallId: '2',
          title: 'command',
          status: 'completed',
        })
      ).toBe('command_execution');
      expect(
        deepseekHarnessAcp.itemType?.({
          toolCallId: '3',
          title: 'exec',
          status: 'completed',
        })
      ).toBe('command_execution');
      expect(
        deepseekHarnessAcp.itemType?.({
          toolCallId: '4',
          title: 'shell',
          status: 'completed',
        })
      ).toBe('command_execution');
      expect(
        deepseekHarnessAcp.itemType?.({
          toolCallId: '5',
          title: 'pwsh',
          status: 'completed',
        })
      ).toBe('command_execution');
    });

    it('returns undefined for other tool titles', () => {
      expect(
        deepseekHarnessAcp.itemType?.({
          toolCallId: '6',
          title: 'read_file',
          status: 'completed',
        })
      ).toBeUndefined();
    });
  });

  it('creates an ACP adapter', () => {
    const adapter = createDeepseekHarnessAdapter();
    expect(adapter).toBeDefined();
    expect(typeof adapter.startSession).toBe('function');
  });
});

