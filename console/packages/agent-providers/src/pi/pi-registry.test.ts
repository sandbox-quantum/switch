import { describe, expect, it } from 'vitest';
import { EXECUTION_INHERIT_ENV } from '../host/agent-env';
import {
  isProviderRuntime,
  providerRuntime,
  providerRuntimeIds,
  providerUnsupportedReason,
} from '../providers/registry';
import { PI_INHERIT_ENV, PI_LOGIN } from './sign-in';

describe('the pi runtime', () => {
  it('is registered, after the providers there were', () => {
    expect(isProviderRuntime('pi')).toBe(true);
    expect(providerRuntimeIds()).toEqual([
      'claude',
      'codex',
      'opencode',
      'antigravity',
      'cursor',
      'pi',
    ]);
  });

  it('signs in with PI_LOGIN and passes Pi’s provider variables to Pi’s sessions only', () => {
    const runtime = providerRuntime('pi');
    expect(runtime.loginCommand).toBe(PI_LOGIN);
    expect(runtime.inheritEnv).toEqual(PI_INHERIT_ENV);
    // Every session gets the shared list; Pi's alone add these (`prepareSharedConfig`).
    for (const name of ['DEEPSEEK_API_KEY', 'GROQ_API_KEY', 'HF_TOKEN', 'AZURE_OPENAI_BASE_URL']) {
      expect(PI_INHERIT_ENV).toContain(name);
      expect(EXECUTION_INHERIT_ENV).not.toContain(name);
    }
  });

  it('is not offered on Windows until it is verified there', () => {
    expect(providerUnsupportedReason('pi', 'win32')).toMatch(/not verified on Windows/);
    expect(providerUnsupportedReason('pi', 'linux')).toBeNull();
    expect(providerUnsupportedReason('pi', 'darwin')).toBeNull();
  });

  it('builds its adapter without starting Pi, with the capabilities sessions advertise', () => {
    const adapter = providerRuntime('pi').createAdapter({
      binaryPath: undefined,
      logger: undefined,
      skill: '',
      serviceSkills: [],
    });
    expect(adapter.provider).toBe('pi');
    expect(adapter.capabilities).toMatchObject({ approvals: true, userInput: false, resume: true });
  });
});
