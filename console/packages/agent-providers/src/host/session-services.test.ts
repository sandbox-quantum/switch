import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ServiceGrant } from './service-access';
import {
  recordedServicesShape,
  recordSessionServices,
  servicesChanged,
  servicesChangeSince,
  servicesShape,
} from './session-services';

const grant = (service: string, overrides: Partial<ServiceGrant> = {}): ServiceGrant => ({
  service,
  access: 'read',
  tool_mode: 'allow',
  tools: [],
  resources: {},
  revision: 1,
  skill: { name: service, content: `# ${service}` },
  mcp_servers: [],
  cli_tools: [],
  ...overrides,
});

describe('the shape of a session’s grants', () => {
  it('changes when a service is granted or taken away', () => {
    const before = servicesShape({ grants: [grant('github')], unavailable: null });
    const after = servicesShape({
      grants: [grant('github'), grant('google-workspace')],
      unavailable: null,
    });
    expect(after).not.toBe(before);
    expect(servicesShape({ grants: [], unavailable: null })).not.toBe(before);
  });

  it('leaves out what tokens carry: access, resources and revision', () => {
    const before = servicesShape({ grants: [grant('github')], unavailable: null });
    const widened = grant('github', {
      access: 'write',
      resources: { repository_ids: [1] },
      revision: 2,
    });
    expect(servicesShape({ grants: [widened], unavailable: null })).toBe(before);
  });

  it('follows which tools may be called, whatever order the grants come in', () => {
    const a = grant('atlassian', { tool_mode: 'deny', tools: ['b', 'a'] });
    const g = grant('github');
    const shape = servicesShape({ grants: [a, g], unavailable: null });
    expect(servicesShape({ grants: [g, { ...a, tools: ['a', 'b'] }], unavailable: null })).toBe(
      shape
    );
    expect(servicesShape({ grants: [g, { ...a, tools: ['a'] }], unavailable: null })).not.toBe(
      shape
    );
  });

  it('is unknown when the grants could not be read', () => {
    expect(servicesShape({ grants: [], unavailable: 'HTTP 503' })).toBeNull();
  });
});

describe('a session’s recorded grants', () => {
  it('reads back what its host recorded, and nothing for a host that recorded none', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-services-'));
    expect(await recordedServicesShape(root)).toBeUndefined();
    await recordSessionServices(root, { grants: [grant('github')], unavailable: null });
    expect(await recordedServicesShape(root)).toBe(
      servicesShape({ grants: [grant('github')], unavailable: null })
    );
    await recordSessionServices(root, { grants: [], unavailable: 'HTTP 503' });
    expect(await recordedServicesShape(root)).toBeNull();
  });

  it('refuses a record it cannot read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-services-'));
    await writeFile(join(root, 'services.json'), '{"shape": 1}');
    await expect(recordedServicesShape(root)).rejects.toThrow();
  });
});

describe('whether a session’s grants changed', () => {
  it('is a change when both sides are known and differ', () => {
    expect(servicesChanged('[]', '[1]')).toBe(true);
    expect(servicesChanged('[1]', '[1]')).toBe(false);
  });

  it('is a change for a host that started without its grants, once they can be read', () => {
    expect(servicesChanged(null, '[]')).toBe(true);
  });

  it('is never a change on a guess', () => {
    expect(servicesChanged(undefined, '[1]')).toBe(false);
    expect(servicesChanged('[]', null)).toBe(false);
  });
});

describe('what a restarted session is told about its services', () => {
  const services = (...names: string[]) => ({
    grants: names.map((name) => grant(name)),
    unavailable: null,
  });
  const shape = (...names: string[]) => servicesShape(services(...names));
  const REMOVED_DATADOG =
    "Datadog was removed from this agent's tools: it was switched off for the workspace, or its grant was removed.";

  it('names a service taken away, and both reasons it may have gone', () => {
    expect(servicesChangeSince(shape('atlassian', 'datadog'), services('atlassian'))).toBe(
      REMOVED_DATADOG
    );
  });

  it('names a service given back, and several at once', () => {
    expect(servicesChangeSince(shape('atlassian'), services('atlassian', 'datadog'))).toBe(
      "Datadog was added to this agent's tools."
    );
    expect(
      servicesChangeSince(shape('datadog', 'github', 'google-workspace'), services('atlassian'))
    ).toBe(
      "Datadog, GitHub and Google Workspace were removed from this agent's tools: each was switched off for the workspace, or its grant was removed. Atlassian was added to this agent's tools."
    );
  });

  it('says nothing when the same services stay, whatever changed in them', () => {
    expect(
      servicesChangeSince(shape('datadog'), {
        grants: [grant('datadog', { tools: ['search'] })],
        unavailable: null,
      })
    ).toBeNull();
  });

  it('says nothing for a new session, or when either side is unknown', () => {
    expect(servicesChangeSince(undefined, services('datadog'))).toBeNull();
    expect(servicesChangeSince(null, services('datadog'))).toBeNull();
    expect(
      servicesChangeSince(shape('datadog'), { grants: [], unavailable: 'Switch is unreachable' })
    ).toBeNull();
  });

  it('is said once for a change: the restart records the grants it started with', async () => {
    // What each start of a session's host does, in order: read the previous
    // host's record, then replace it with its own.
    const root = await mkdtemp(join(tmpdir(), 'session-services-'));
    const hostStarts = async (now: ReturnType<typeof services>) => {
      const change = servicesChangeSince(await recordedServicesShape(root), now);
      await recordSessionServices(root, now);
      return change;
    };
    expect(await hostStarts(services('atlassian', 'datadog'))).toBeNull();
    expect(await hostStarts(services('atlassian'))).toBe(REMOVED_DATADOG);
    expect(await hostStarts(services('atlassian'))).toBeNull();
  });
});
