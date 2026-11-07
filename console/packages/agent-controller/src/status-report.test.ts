import { describe, expect, it } from 'vitest';
import { Printer, visibleWidth } from './output';
import { agentMark, renderStatus, type StatusAgent, type StatusDocument } from './status-report';

function agent(overrides: Partial<StatusAgent> = {}): StatusAgent {
  return {
    id: 'agent-4c91de',
    name: 'reviewer',
    provider: 'claude',
    desiredState: 'running',
    revision: 5,
    appliedRevision: 5,
    process: 'running',
    reason: null,
    detail: null,
    ...overrides,
  };
}

function document(overrides: Partial<StatusDocument> = {}): StatusDocument {
  return {
    schema: 'switch-agent-controller/status@1',
    version: '0.2.0',
    dataDir: '/var/lib/controller',
    enrolled: true,
    controller: {
      id: 'controller-1',
      name: 'build-box',
      server: 'https://switch.example.invalid',
      enrolledAt: '2026-10-01T00:00:00Z',
    },
    secretStore: 'the macOS keychain',
    credential: 'present',
    revokedAt: null,
    relay: 'http://127.0.0.1:41917',
    separateUsers: null,
    assignment: { state: 'saved', revision: 12, agents: [agent()] },
    ...overrides,
  };
}

/** The visible text of `line` up to where `text` starts. */
function before(line: string, text: string): string {
  const plain = line.replace(/\u001B\[[0-9;]*m/g, '');
  return plain.slice(0, plain.indexOf(text));
}

function render(doc: StatusDocument, color: boolean): string[] {
  const written: string[] = [];
  renderStatus(
    Printer.to((text) => written.push(text), color),
    doc
  );
  return written.join('').split('\n');
}

describe('agentMark', () => {
  it('marks what a reader should look at first', () => {
    expect(agentMark(agent({ process: 'running' }))).toBe('ok');
    expect(agentMark(agent({ process: 'crashed' }))).toBe('fail');
    expect(agentMark(agent({ process: 'failed' }))).toBe('fail');
    expect(agentMark(agent({ process: 'starting' }))).toBe('warn');
    expect(agentMark(agent({ process: 'stopped', desiredState: 'stopped' }))).toBe('ok');
    expect(agentMark(agent({ process: 'stopped', desiredState: 'running' }))).toBe('warn');
  });
});

describe('renderStatus', () => {
  it('writes the same text with and without colour', () => {
    const strip = (line: string) => line.replace(/\u001B\[[0-9;]*m/g, '');
    expect(render(document(), true).map(strip)).toEqual(render(document(), false));
  });

  it('keeps the agent columns aligned when a cell is coloured', () => {
    const doc = document({
      assignment: {
        state: 'saved',
        revision: 12,
        agents: [
          agent(),
          agent({
            id: 'agent-90ab12',
            name: 'release-notes-writer',
            provider: 'codex',
            process: 'crashed',
            appliedRevision: null,
            reason: 'internal',
            detail: 'The agent host is not running.',
          }),
        ],
      },
    });
    const coloured = render(doc, true).filter(
      (line) => line.includes('agent-4') || line.includes('agent-9')
    );
    expect(coloured).toHaveLength(2);
    const [first = '', second = ''] = coloured;
    expect(first).toMatch(/\u001B\[/);
    expect(visibleWidth(before(first, 'claude'))).toBe(visibleWidth(before(second, 'codex')));
  });

  it('names the fix when the machine is not enrolled', () => {
    const lines = render(
      document({ enrolled: false, controller: null, secretStore: null, credential: null }),
      false
    );
    expect(lines.join('\n')).toContain('Not enrolled.');
    expect(lines.join('\n')).toContain('Fix: switch-agent-controller enroll');
  });

  it('says an assignment was never pulled, rather than showing nothing', () => {
    expect(render(document({ assignment: { state: 'none' } }), false).join('\n')).toContain(
      'not pulled yet'
    );
  });

  it('shows a revoked credential in its own right', () => {
    const lines = render(
      document({ credential: 'revoked', revokedAt: '2026-10-02T00:00:00Z' }),
      false
    ).join('\n');
    expect(lines).toContain('revoked at 2026-10-02T00:00:00Z');
  });
});
