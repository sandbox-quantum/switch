import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENTS_DIR_RELATIVE, distinctEndpoints, readAgentStore } from './credentials';

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function root(): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'switch-store-test-'));
  roots.push(dir);
  return dir;
}

function writeAgentsFile(base: string, name: string, body: unknown, mode?: number): string {
  const dir = path.join(base, AGENTS_DIR_RELATIVE);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(body), mode === undefined ? undefined : { mode });
  if (mode !== undefined) fs.chmodSync(file, mode);
  return file;
}

/** Collect warnings so a test can assert on what the user was told. */
function collector(): { warn: (m: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (m) => messages.push(m), messages };
}

describe('readAgentStore', () => {
  it('is empty, not an error, when the machine has no store at all', () => {
    const { warn, messages } = collector();
    const store = readAgentStore(root(), root(), warn);

    expect(store.agents).toEqual([]);
    expect(store.unusable).toEqual([]);
    expect(messages).toEqual([]);
  });

  it('resolves an agent from the split store', () => {
    const project = root();
    const home = root();
    writeAgentsFile(project, 'reviewer.json', {
      name: 'reviewer',
      agent_id: 'agent-uuid-1',
      endpoint: 'https://switch.example',
    });
    writeAgentsFile(home, 'agent-uuid-1.json', { token: 'tok-abc' }, 0o600);

    const { warn, messages } = collector();
    const store = readAgentStore(project, home, warn);

    expect(store.unusable).toEqual([]);
    expect(store.agents).toEqual([
      {
        slug: 'reviewer',
        name: 'reviewer',
        agentId: 'agent-uuid-1',
        endpoint: 'https://switch.example',
        token: 'tok-abc',
        tokenInWorkingTree: false,
      },
    ]);
    expect(messages).toEqual([]);
  });

  it('keys the secret by agent id, so same-named agents on two servers do not collide', () => {
    const project = root();
    const home = root();
    writeAgentsFile(project, 'reviewer-dev.json', {
      name: 'reviewer',
      agent_id: 'uuid-dev',
      endpoint: 'https://dev.example',
    });
    writeAgentsFile(project, 'reviewer-prod.json', {
      name: 'reviewer',
      agent_id: 'uuid-prod',
      endpoint: 'https://prod.example',
    });
    writeAgentsFile(home, 'uuid-dev.json', { token: 'tok-dev' }, 0o600);
    writeAgentsFile(home, 'uuid-prod.json', { token: 'tok-prod' }, 0o600);

    const store = readAgentStore(project, home, collector().warn);

    expect(store.agents.map((a) => a.token).sort()).toEqual(['tok-dev', 'tok-prod']);
    expect(distinctEndpoints(store.agents)).toEqual([
      'https://dev.example',
      'https://prod.example',
    ]);
  });

  it('still reads the pre-split file switchdash wrote, but says the token is exposed', () => {
    const project = root();
    writeAgentsFile(project, 'legacy.json', {
      env: {
        SWITCH_API_ENDPOINT: 'https://switch.example',
        SWITCH_API_TOKEN: 'tok-legacy',
        SWITCH_AGENT_ID: 'agent-uuid-2',
      },
    });

    const { warn, messages } = collector();
    const store = readAgentStore(project, root(), warn);

    expect(store.agents).toHaveLength(1);
    expect(store.agents[0]).toMatchObject({
      name: 'legacy',
      agentId: 'agent-uuid-2',
      token: 'tok-legacy',
      tokenInWorkingTree: true,
    });
    expect(messages.join('\n')).toContain('token is still inside the working tree');
  });

  it('prefers the home secret over a token left inline', () => {
    const project = root();
    const home = root();
    writeAgentsFile(project, 'both.json', {
      agent_id: 'agent-uuid-3',
      endpoint: 'https://switch.example',
      env: { SWITCH_API_TOKEN: 'tok-stale' },
    });
    writeAgentsFile(home, 'agent-uuid-3.json', { token: 'tok-current' }, 0o600);

    const store = readAgentStore(project, home, collector().warn);

    expect(store.agents[0].token).toBe('tok-current');
    expect(store.agents[0].tokenInWorkingTree).toBe(false);
  });

  it('reports a named agent whose secret is missing, rather than dropping it', () => {
    const project = root();
    const home = root();
    writeAgentsFile(project, 'orphan.json', {
      agent_id: 'agent-uuid-4',
      endpoint: 'https://switch.example',
    });

    const store = readAgentStore(project, home, collector().warn);

    expect(store.agents).toEqual([]);
    expect(store.unusable).toHaveLength(1);
    expect(store.unusable[0].slug).toBe('orphan');
    expect(store.unusable[0].reason).toContain('agent-uuid-4.json');
  });

  it('reports a malformed entry instead of skipping it silently', () => {
    const project = root();
    const dir = path.join(project, AGENTS_DIR_RELATIVE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'broken.json'), '{not json');

    const store = readAgentStore(project, root(), collector().warn);

    expect(store.agents).toEqual([]);
    expect(store.unusable[0]).toMatchObject({ slug: 'broken' });
    expect(store.unusable[0].reason).toContain('malformed');
  });

  it('warns when a secret is readable by other users', () => {
    const project = root();
    const home = root();
    writeAgentsFile(project, 'loose.json', {
      agent_id: 'agent-uuid-5',
      endpoint: 'https://switch.example',
    });
    writeAgentsFile(home, 'agent-uuid-5.json', { token: 'tok-loose' }, 0o644);

    const { warn, messages } = collector();
    const store = readAgentStore(project, home, warn);

    expect(store.agents).toHaveLength(1);
    expect(messages.join('\n')).toContain('readable by other users');
  });

  it('ignores non-JSON files in the store directory', () => {
    const project = root();
    const dir = path.join(project, AGENTS_DIR_RELATIVE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.gitignore'), '*\n');

    const store = readAgentStore(project, root(), collector().warn);

    expect(store.agents).toEqual([]);
    expect(store.unusable).toEqual([]);
  });
});

describe('distinctEndpoints', () => {
  it('collapses trailing-slash variants of the same server', () => {
    const agents = [
      { endpoint: 'https://switch.example' },
      { endpoint: 'https://switch.example/' },
    ] as Parameters<typeof distinctEndpoints>[0];

    expect(distinctEndpoints(agents)).toEqual(['https://switch.example']);
  });
});
