import { describe, expect, it } from 'vitest';
import {
  enrollCommand,
  enrollmentRefusal,
  installCommand,
  type MachineEnrollment,
  shellQuote,
} from './machine-enrollment';

describe('machine enrollment commands', () => {
  it('quotes only what the shell would misread', () => {
    expect(shellQuote('https://switch.example.com')).toBe('https://switch.example.com');
    expect(shellQuote("the box's GPU")).toBe(`'the box'\\''s GPU'`);
  });

  it('installs and enrolls with the code, leaving a blank name and description out', () => {
    expect(
      installCommand('https://switch.example.com', 'abc', { name: ' ', description: '' })
    ).toBe(
      'curl -fsSL https://raw.githubusercontent.com/sandbox-quantum/switch/main/console/packages/agent-controller/install.sh | sh -s -- --server https://switch.example.com --code abc'
    );
  });

  it('enrolls an installed controller with the name and description given', () => {
    expect(
      enrollCommand('https://switch.example.com', 'abc', {
        name: 'build-box',
        description: 'In the office',
      })
    ).toBe(
      "switch-agent-controller enroll --server https://switch.example.com --code abc --name build-box --description 'In the office'"
    );
  });
});

describe('enrollmentRefusal', () => {
  const issued = (patch: Partial<MachineEnrollment>): MachineEnrollment => ({
    code: 'abc',
    expiresAt: '2026-11-17T10:10:00Z',
    serverUrl: 'https://switch.example.com',
    loopback: false,
    fallback: false,
    remoteDevices: { supported: true, reason: null },
    ...patch,
  });

  it('refuses nothing at an address other devices reach', () => {
    expect(enrollmentRefusal(issued({}))).toBeNull();
    // The fallback notice, not a refusal, covers an address Console only guessed.
    expect(enrollmentRefusal(issued({ fallback: true }))).toBeNull();
    // An older server says nothing, and the address decides.
    expect(enrollmentRefusal(issued({ remoteDevices: null }))).toBeNull();
  });

  it('gives the reason the server refuses with', () => {
    const reason = 'This Switch is run by Switch Console, so other devices cannot be added.';
    expect(enrollmentRefusal(issued({ remoteDevices: { supported: false, reason } }))).toBe(reason);
    expect(
      enrollmentRefusal(issued({ remoteDevices: { supported: false, reason: null } }))
    ).toMatch(/no other device can reach it/);
  });

  it('refuses a loopback address the server named, for a server too old to say', () => {
    const refusal = enrollmentRefusal(
      issued({ serverUrl: 'http://localhost:8000', loopback: true, remoteDevices: null })
    );
    expect(refusal).toContain("This server's public address is http://localhost:8000");
    expect(refusal).toContain('GATEWAY_PUBLIC_URL');
  });

  it('refuses the loopback address Console falls back to when the server names none', () => {
    const refusal = enrollmentRefusal(
      issued({ serverUrl: 'http://127.0.0.1:8000', loopback: true, fallback: true })
    );
    expect(refusal).toContain('no public address set');
    expect(refusal).toContain('http://127.0.0.1:8000');
    expect(refusal).toContain('GATEWAY_PUBLIC_URL');
  });
});
