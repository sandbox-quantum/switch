import { describe, expect, it } from 'vitest';
import { kiroAcp, parseKiroWhoami } from './kiro-acp';

describe('Kiro ACP hooks', () => {
  it('launches V3 without legacy model, agent, or trust flags', () => {
    expect(kiroAcp.launch({ binaryPath: '/bin/kiro-cli', cwd: '/tmp', env: {} })).toEqual({
      command: '/bin/kiro-cli',
      args: ['acp', '--agent-engine=v3'],
      env: {},
    });
  });

  it('recognizes signed-out and signed-in account states', () => {
    expect(parseKiroWhoami('{"account":null}').status).toBe('unauthenticated');
    expect(parseKiroWhoami('{"account":{"id":"example"}}').status).toBe('authenticated');
  });

  it('does not claim readiness for malformed or ambiguous status output', () => {
    for (const output of ['', 'not json', '{}', '{"account":false}', '{"account":"x"}']) {
      expect(parseKiroWhoami(output).status).toBe('unknown');
    }
  });
});
