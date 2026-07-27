import { describe, expect, it } from 'vitest';
import { buildCodexAutoApproveFlag } from './auto-approve';

describe('buildCodexAutoApproveFlag', () => {
  it('defaults to full access + no approvals when unset', () => {
    expect(buildCodexAutoApproveFlag({})).toBe(
      '-c approval_policy="never" -c sandbox_mode="danger-full-access" --dangerously-bypass-hook-trust'
    );
  });

  it('honors a CODEX_SANDBOX_MODE override', () => {
    expect(buildCodexAutoApproveFlag({ CODEX_SANDBOX_MODE: 'workspace-write' })).toBe(
      '-c approval_policy="never" -c sandbox_mode="workspace-write" --dangerously-bypass-hook-trust'
    );
  });

  it('honors a CODEX_APPROVAL_POLICY override', () => {
    expect(buildCodexAutoApproveFlag({ CODEX_APPROVAL_POLICY: 'on-request' })).toBe(
      '-c approval_policy="on-request" -c sandbox_mode="danger-full-access" --dangerously-bypass-hook-trust'
    );
  });

  it('honors both overrides together', () => {
    expect(
      buildCodexAutoApproveFlag({
        CODEX_SANDBOX_MODE: 'read-only',
        CODEX_APPROVAL_POLICY: 'untrusted',
      })
    ).toBe(
      '-c approval_policy="untrusted" -c sandbox_mode="read-only" --dangerously-bypass-hook-trust'
    );
  });

  it('trims whitespace and treats a blank value as unset', () => {
    expect(buildCodexAutoApproveFlag({ CODEX_SANDBOX_MODE: '  workspace-write  ' })).toContain(
      'sandbox_mode="workspace-write"'
    );
    expect(buildCodexAutoApproveFlag({ CODEX_SANDBOX_MODE: '   ' })).toContain(
      'sandbox_mode="danger-full-access"'
    );
  });

  it('always keeps --dangerously-bypass-hook-trust (needed for the SessionStart hook)', () => {
    expect(buildCodexAutoApproveFlag({ CODEX_SANDBOX_MODE: 'read-only' })).toContain(
      '--dangerously-bypass-hook-trust'
    );
  });

  it('throws on an unknown sandbox mode rather than silently widening access', () => {
    expect(() => buildCodexAutoApproveFlag({ CODEX_SANDBOX_MODE: 'full' })).toThrow(
      /Invalid CODEX_SANDBOX_MODE="full"/
    );
  });

  it('throws on an unknown approval policy', () => {
    expect(() => buildCodexAutoApproveFlag({ CODEX_APPROVAL_POLICY: 'yolo' })).toThrow(
      /Invalid CODEX_APPROVAL_POLICY="yolo"/
    );
  });
});
