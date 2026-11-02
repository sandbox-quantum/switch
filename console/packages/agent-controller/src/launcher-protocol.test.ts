import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  encodeLine,
  LAUNCHER_LINE_MAX,
  type LauncherOrder,
  launcherOrderSchema,
  type LauncherReport,
  launcherReportSchema,
  LineReader,
  type LineRefusal,
  hostFailureCode,
} from './launcher-protocol';

const AGENT = '0fa651dd-faa3-4dda-80b8-f784b1750c95';
const launch: LauncherOrder = {
  kind: 'launch',
  id: 1,
  agentId: AGENT,
  launchId: 7,
  template: { start: { provider: 'claude' } },
  marker: 'a'.repeat(64),
  ticket: 'b'.repeat(32),
  credentials: {
    endpoint: 'http://127.0.0.1:19223',
    token: 'swlr_x',
    hub: 'ws://127.0.0.1:19223/hub',
  },
  restart: false,
  replaceIdentity: false,
  clearTakenOver: false,
};

function reader<T>(schema: z.ZodType<T>, max?: number) {
  const messages: T[] = [];
  const refused: LineRefusal[] = [];
  const r = new LineReader<T>(
    schema,
    (m) => messages.push(m),
    (why) => refused.push(why),
    max
  );
  return { r, messages, refused };
}

describe('the launcher protocol', () => {
  it('passes each order the controller sends, as it was sent', () => {
    const { r, messages, refused } = reader<LauncherOrder>(launcherOrderSchema);
    const orders: LauncherOrder[] = [
      launch,
      { kind: 'stop', id: 2, agentId: AGENT, wait: true, asked: false },
      { kind: 'observe', id: 3, agentId: AGENT },
      { kind: 'end', id: 4, agentId: AGENT },
      { kind: 'sweep', id: 5, agentId: AGENT },
      { kind: 'ticket', id: 6, agentId: AGENT, launchId: 7, ticket: 'c'.repeat(32) },
    ];
    r.feed(Buffer.from(orders.map(encodeLine).join('')));
    expect(messages).toEqual(orders);
    expect(refused).toEqual([]);
  });

  it('passes the launcher reports with ids and numbers only', () => {
    const { r, messages, refused } = reader<LauncherReport>(launcherReportSchema);
    const reports: LauncherReport[] = [
      { kind: 'hello', version: '0.2.0', bundle: 'abc', bootId: 'd'.repeat(32) },
      {
        kind: 'measure',
        at: 1,
        agents: { [AGENT]: { bytes: 1024, processes: 3, disputedBytes: 0 } },
      },
      {
        kind: 'reply',
        id: 4,
        ok: true,
        counts: { signalled: 2, gone: 0, notProven: 1, disputed: 0, left: 0 },
      },
      { kind: 'reply', id: 5, ok: false, code: 'unknown_agent' },
      { kind: 'exited', agentId: AGENT, launchId: 7 },
    ];
    r.feed(Buffer.from(reports.map(encodeLine).join('')));
    expect(messages).toEqual(reports);
    expect(refused).toEqual([]);
  });

  it('refuses an unknown kind, an extra field, a path for an agent id, free text for a code, and keeps going', () => {
    const { r, messages, refused } = reader<LauncherReport>(launcherReportSchema);
    const lines = [
      { kind: 'exec', command: 'rm -rf /' },
      { kind: 'exited', agentId: AGENT, launchId: 7, pid: 1 },
      { kind: 'exited', agentId: '../../controller', launchId: 7 },
      { kind: 'reply', id: 1, ok: false, code: 'Permission denied: /data/controller/secrets' },
      // A well-formed code that isn't on the list, and a hello whose labels aren't safe to log.
      { kind: 'reply', id: 1, ok: false, code: 'not_a_code' },
      { kind: 'hello', version: '0.2.0\nFAKE LOG LINE', bundle: 'b', bootId: 'd'.repeat(32) },
      { kind: 'hello', version: '0.2.0', bundle: '/data/controller/x.mjs', bootId: 'd'.repeat(32) },
      {
        kind: 'measure',
        at: 1,
        agents: { 'not-an-id': { bytes: 1, processes: 1, disputedBytes: 0 } },
      },
      { kind: 'exited', agentId: AGENT, launchId: 8 },
    ];
    r.feed(Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join('')));
    expect(refused).toEqual(Array(8).fill('bad_shape'));
    expect(messages).toEqual([{ kind: 'exited', agentId: AGENT, launchId: 8 }]);
  });

  it('drops a line past the cap without holding it, across chunks, and reads the next one', () => {
    const { r, messages, refused } = reader<LauncherReport>(launcherReportSchema, 1024);
    const huge = `{"kind":"hello","version":"${'x'.repeat(4000)}"`;
    r.feed(Buffer.from(huge.slice(0, 600)));
    r.feed(Buffer.from(huge.slice(600)));
    r.feed(Buffer.from(`}\n${encodeLine({ kind: 'exited', agentId: AGENT, launchId: 1 })}`));
    expect(refused).toEqual(['too_long']);
    expect(messages).toEqual([{ kind: 'exited', agentId: AGENT, launchId: 1 }]);
  });

  it('refuses a line that is not JSON, and joins a message split over chunks', () => {
    const { r, messages, refused } = reader<LauncherReport>(launcherReportSchema);
    const line = encodeLine({ kind: 'exited', agentId: AGENT, launchId: 2 });
    r.feed(Buffer.from('not json\n'));
    r.feed(Buffer.from(line.slice(0, 10)));
    r.feed(Buffer.from(line.slice(10)));
    expect(refused).toEqual(['not_json']);
    expect(messages).toEqual([{ kind: 'exited', agentId: AGENT, launchId: 2 }]);
  });

  it('caps a line at 256 KiB by default, enough for a launch with its template', () => {
    expect(LAUNCHER_LINE_MAX).toBe(256 * 1024);
    expect(encodeLine(launch).length).toBeLessThan(LAUNCHER_LINE_MAX);
  });

  it('reads a host failure as a code, never its words', () => {
    expect(hostFailureCode('Switch rejected the agent credentials (401)')).toBe(
      'credentials_rejected'
    );
    expect(hostFailureCode('Provider executable is missing')).toBe('provider_missing');
    expect(hostFailureCode('Shared SDK host exited with code 1. Inspect worker.log')).toBe(
      'host_failed'
    );
  });

  it('carries no gateway record in a launch: the host gets its token in the start environment', () => {
    const { r, messages, refused } = reader<LauncherOrder>(launcherOrderSchema);
    r.feed(
      Buffer.from(
        `${JSON.stringify({
          kind: 'launch',
          id: 1,
          agentId: AGENT,
          launchId: 1,
          template: {},
          marker: 'a'.repeat(64),
          ticket: 'b'.repeat(32),
          credentials: {
            endpoint: 'e',
            token: 't',
            hub: 'h',
            gateway: { endpoint: 'g', token: 'swpg_x' },
          },
          restart: false,
          replaceIdentity: false,
          clearTakenOver: false,
        })}\n`
      )
    );
    expect(messages).toEqual([]);
    expect(refused).toEqual(['bad_shape']);
  });
});
