import { describe, expect, it } from 'vitest';
import { enrollCommand, installCommand, shellQuote } from './machine-enrollment';

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
