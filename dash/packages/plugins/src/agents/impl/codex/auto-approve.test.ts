import { describe, expect, it } from 'vitest';
import { buildCodexAutoApproveFlag, CODEX_HOOK_TRUST_FLAG } from './auto-approve';

describe('buildCodexAutoApproveFlag', () => {
  it('defaults to full access + no approvals when unset', () => {
    expect(buildCodexAutoApproveFlag({})).toBe(
      '-c approval_policy="never" -c sandbox_mode="danger-full-access"'
    );
  });

  it('honors a CODEX_SANDBOX_MODE override', () => {
    expect(buildCodexAutoApproveFlag({ CODEX_SANDBOX_MODE: 'workspace-write' })).toBe(
      '-c approval_policy="never" -c sandbox_mode="workspace-write"'
    );
  });

  it('honors a CODEX_APPROVAL_POLICY override', () => {
    expect(buildCodexAutoApproveFlag({ CODEX_APPROVAL_POLICY: 'on-request' })).toBe(
      '-c approval_policy="on-request" -c sandbox_mode="danger-full-access"'
    );
  });

  it('honors both overrides together', () => {
    expect(
      buildCodexAutoApproveFlag({
        CODEX_SANDBOX_MODE: 'read-only',
        CODEX_APPROVAL_POLICY: 'untrusted',
      })
    ).toBe('-c approval_policy="untrusted" -c sandbox_mode="read-only"');
  });

  it('trims whitespace and treats a blank value as unset', () => {
    expect(buildCodexAutoApproveFlag({ CODEX_SANDBOX_MODE: '  workspace-write  ' })).toContain(
      'sandbox_mode="workspace-write"'
    );
    expect(buildCodexAutoApproveFlag({ CODEX_SANDBOX_MODE: '   ' })).toContain(
      'sandbox_mode="danger-full-access"'
    );
  });

  it('no longer carries hook trust, which every session needs regardless', () => {
    // Gating trust on auto-approve left a default agent running none of
    // switchdash's hooks; it is a default arg now. See CODEX_HOOK_TRUST_FLAG.
    expect(buildCodexAutoApproveFlag({ CODEX_SANDBOX_MODE: 'read-only' })).not.toContain(
      CODEX_HOOK_TRUST_FLAG
    );
    expect(CODEX_HOOK_TRUST_FLAG).toBe('--dangerously-bypass-hook-trust');
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
