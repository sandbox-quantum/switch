import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENTS_DIR_RELATIVE,
  distinctEndpoints,
  normalizeEndpoint,
  readAgentStore,
} from './credentials';

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function root(): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'switch-store-test-'));
  roots.push(dir);
  return dir;
}

function writeEntry(base: string, name: string, body: unknown): void {
  const dir = path.join(base, AGENTS_DIR_RELATIVE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(body));
}

/** The shape switchdash writes, and that Claude Code reads natively. */
function credsEnv(agentId: string, token = 'tok-abc', endpoint = 'https://switch.example') {
  return {
    env: { SWITCH_API_ENDPOINT: endpoint, SWITCH_API_TOKEN: token, SWITCH_AGENT_ID: agentId },
  };
}

describe('readAgentStore', () => {
  it('is empty, not an error, when the directory has no store at all', () => {
    const store = readAgentStore(root());

    expect(store.agents).toEqual([]);
    expect(store.unusable).toEqual([]);
  });

  it('resolves an agent from the file switchdash writes', () => {
    const project = root();
    writeEntry(project, 'reviewer.json', credsEnv('agent-uuid-1'));

    expect(readAgentStore(project).agents).toEqual([
      {
        slug: 'reviewer',
        name: 'reviewer',
        agentId: 'agent-uuid-1',
        endpoint: 'https://switch.example',
        token: 'tok-abc',
      },
    ]);
  });

  it('accepts flat field names as well as the env block', () => {
    const project = root();
    writeEntry(project, 'flat.json', {
      name: 'reviewer',
      agent_id: 'agent-uuid-2',
      endpoint: 'https://switch.example',
      token: 'tok-flat',
    });

    expect(readAgentStore(project).agents[0]).toMatchObject({
      name: 'reviewer',
      agentId: 'agent-uuid-2',
      token: 'tok-flat',
    });
  });

  it('reports an entry missing its token, rather than dropping it', () => {
    const project = root();
    writeEntry(project, 'orphan.json', {
      env: { SWITCH_API_ENDPOINT: 'https://switch.example', SWITCH_AGENT_ID: 'agent-uuid-3' },
    });

    const store = readAgentStore(project);

    expect(store.agents).toEqual([]);
    expect(store.unusable).toHaveLength(1);
    expect(store.unusable[0].slug).toBe('orphan');
    expect(store.unusable[0].reason).toContain('no API token');
  });

  it('reports a malformed entry instead of skipping it silently', () => {
    const project = root();
    const dir = path.join(project, AGENTS_DIR_RELATIVE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'broken.json'), '{not json');

    const store = readAgentStore(project);

    expect(store.agents).toEqual([]);
    expect(store.unusable[0]).toMatchObject({ slug: 'broken' });
    expect(store.unusable[0].reason).toContain('malformed');
  });

  it('reads every agent provisioned in the directory', () => {
    const project = root();
    writeEntry(project, 'alice.json', credsEnv('uuid-a', 'tok-a'));
    writeEntry(project, 'bob.json', credsEnv('uuid-b', 'tok-b'));

    expect(
      readAgentStore(project)
        .agents.map((a) => a.token)
        .sort()
    ).toEqual(['tok-a', 'tok-b']);
  });

  it('ignores non-JSON files in the store directory', () => {
    const project = root();
    const dir = path.join(project, AGENTS_DIR_RELATIVE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.gitignore'), '*\n');

    const store = readAgentStore(project);

    expect(store.agents).toEqual([]);
    expect(store.unusable).toEqual([]);
  });
});

describe('distinctEndpoints', () => {
  it('separates agents belonging to different servers', () => {
    const project = root();
    writeEntry(project, 'dev.json', credsEnv('uuid-dev', 'tok-dev', 'https://dev.example'));
    writeEntry(project, 'prod.json', credsEnv('uuid-prod', 'tok-prod', 'https://prod.example'));

    expect(distinctEndpoints(readAgentStore(project).agents)).toEqual([
      'https://dev.example',
      'https://prod.example',
    ]);
  });

  it('collapses trailing-slash variants of the same server', () => {
    const agents = [
      { endpoint: 'https://switch.example' },
      { endpoint: 'https://switch.example/' },
    ] as Parameters<typeof distinctEndpoints>[0];

    expect(distinctEndpoints(agents)).toEqual(['https://switch.example']);
  });
});

describe('normalizeEndpoint', () => {
  it('folds the case of the parts that are defined to be case-insensitive', () => {
    // This gates whether an identity binds, not just how endpoints are grouped
    // for display, so a differently-cased host must not read as another server.
    expect(normalizeEndpoint('HTTPS://Switch.Example')).toBe('https://switch.example');
    expect(normalizeEndpoint('https://switch.example/')).toBe('https://switch.example');
    expect(normalizeEndpoint('  https://Switch.Example:8000/  ')).toBe(
      'https://switch.example:8000'
    );
  });

  it('leaves the path alone, which is case-sensitive', () => {
    expect(normalizeEndpoint('https://Switch.Example/Api/V1')).toBe(
      'https://switch.example/Api/V1'
    );
  });

  it('passes through a value with no authority to fold', () => {
    expect(normalizeEndpoint('localhost:8000')).toBe('localhost:8000');
  });
});
